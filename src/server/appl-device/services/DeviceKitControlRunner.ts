import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { TypedEmitter } from '../../../common/TypedEmitter';
import { IosControlMethod } from '../../../common/IosControlMethod';
import { WdaStatus } from '../../../common/WdaStatus';
import { WdaRunnerEvents } from './WDARunner';
import { requestJson } from './AppiumRunner';
import { DeviceKitRegistry } from './DeviceKitRegistry';

const HEALTH_TIMEOUT = 3000;
const HEALTH_ATTEMPTS = 3;
const RPC_TIMEOUT = 30000;

// A point of the gesture trail recorded in the browser, already converted
// to device points; `t` is milliseconds since the gesture started.
interface TrailPoint {
    x: number;
    y: number;
    t: number;
}

interface GestureAction {
    type: 'press' | 'move' | 'release';
    duration: number;
    x: number;
    y: number;
    button: number;
}

/**
 * iOS control backend talking JSON-RPC to the DeviceKit agent (0.0.18) that
 * already streams the video — one XCUITest runner per device for both video
 * and control, so gestures no longer fight a second (WDA) runner.
 *
 * Drop-in replacement for {@link WdaRunner}: same events, same
 * `request(command)` contract, selected in IosControlProxy via
 * `WS_SCRCPY_IOS_CONTROL` (devicekit | wda).
 *
 * DeviceKit 0.0.18 RPC used here (verified against the 0.0.18 source tag):
 *   device.io.tap {x, y}                     - coordinates in points
 *   device.io.longpress {x, y, duration}
 *   device.io.gesture {actions: [...]}       - press/move/release with timing
 *   device.io.button {button}                - home | lock | volumeUp | volumeDown
 *   device.io.text {text}
 *   device.info {}                           - {screenSize: {width, height}, scale}
 * "back" and "appSwitcher" have no hardware buttons on iOS - they are
 * synthesized as gestures (left-edge swipe / bottom swipe-up-and-hold).
 */
export class DeviceKitControlRunner extends TypedEmitter<WdaRunnerEvents> {
    protected static TAG = 'DeviceKitControlRunner';
    private static instances: Map<string, DeviceKitControlRunner> = new Map();
    public static SHUTDOWN_TIMEOUT = 15000;

    public static getInstance(udid: string): DeviceKitControlRunner {
        let instance = this.instances.get(udid);
        if (!instance) {
            instance = new DeviceKitControlRunner(udid);
            this.instances.set(udid, instance);
        }
        instance.lock();
        return instance;
    }

    protected name: string;
    protected started = false;
    protected starting = false;
    private readonly baseUrl: string;
    private screenSize?: { width: number; height: number };
    private rpcId = 0;
    private holders = 0;
    protected releaseTimeoutId?: NodeJS.Timeout;

    constructor(private readonly udid: string) {
        super();
        this.name = `[${DeviceKitControlRunner.TAG}][udid: ${this.udid}]`;
        this.baseUrl = DeviceKitRegistry.baseUrl(udid);
    }

    protected lock(): void {
        if (this.releaseTimeoutId) {
            clearTimeout(this.releaseTimeoutId);
            this.releaseTimeoutId = undefined;
        }
        this.holders++;
    }

    protected unlock(): void {
        this.holders--;
        if (this.holders > 0) {
            return;
        }
        this.releaseTimeoutId = setTimeout(() => {
            DeviceKitControlRunner.instances.delete(this.udid);
        }, DeviceKitControlRunner.SHUTDOWN_TIMEOUT);
    }

    public async start(): Promise<void> {
        if (this.started || this.starting) {
            return;
        }
        this.starting = true;
        this.emit('status-change', { status: WdaStatus.STARTING });
        try {
            await this.ensureReady();
            this.emit('status-change', { status: WdaStatus.STARTED });
        } catch (error) {
            this.emit('error', error instanceof Error ? error : new Error(String(error)));
        } finally {
            this.starting = false;
        }
    }

    public isStarted(): boolean {
        return this.started;
    }

    public release(): void {
        this.unlock();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public async request(command: ControlCenterCommand): Promise<any> {
        // Auto-heal: if the agent was restarted (weekly re-sign, unplug), probe it
        // again on the next request instead of staying dead until a tab reload.
        if (!this.started) {
            await this.ensureReady();
            this.emit('status-change', { status: WdaStatus.STARTED });
        }
        const method = command.getMethod();
        const args = command.getArgs();
        try {
            switch (method) {
                case IosControlMethod.GET_SCREEN_WIDTH:
                    return this.screenSize ? this.screenSize.width : 0;
                case IosControlMethod.CLICK:
                    return await this.rpc('device.io.tap', { x: args.x, y: args.y });
                case IosControlMethod.LONG_PRESS:
                    return await this.rpc('device.io.longpress', {
                        x: args.x,
                        y: args.y,
                        duration: DeviceKitControlRunner.clampDuration(args.duration, 0.8),
                    });
                case IosControlMethod.SCROLL:
                    return await this.performScroll(args);
                case IosControlMethod.PRESS_BUTTON:
                    return await this.pressButton(args.name);
                case IosControlMethod.SEND_KEYS:
                    return await this.rpc('device.io.text', {
                        text: Array.isArray(args.keys) ? args.keys.join('') : String(args.keys),
                    });
                case IosControlMethod.APPIUM_SETTINGS:
                    // MJPEG-specific, nothing to configure on the DeviceKit side.
                    return { ignored: true };
                default:
                    return `Unknown command: ${method}`;
            }
        } catch (error) {
            this.onAgentUnreachable(error);
            throw error;
        }
    }

    private async ensureReady(): Promise<void> {
        let lastError: Error | undefined;
        for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
            try {
                const { status } = await requestJson('GET', `${this.baseUrl}/health`, undefined, HEALTH_TIMEOUT);
                if (status >= 200 && status < 300) {
                    lastError = undefined;
                    break;
                }
                lastError = new Error(`DeviceKit /health returned HTTP ${status}`);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (lastError) {
            throw new Error(
                `DeviceKit agent is not reachable at ${this.baseUrl} (${lastError.message}). ` +
                    `Is "ios ui run devicekit" running for ${this.udid}?`,
            );
        }
        const info = await this.rpc('device.info', {});
        const screenSize = info && info.screenSize;
        if (!screenSize || !screenSize.width) {
            throw new Error(`DeviceKit device.info returned no screenSize: ${JSON.stringify(info)}`);
        }
        this.screenSize = { width: screenSize.width, height: screenSize.height };
        this.started = true;
    }

    private onAgentUnreachable(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        if (/ECONNREFUSED|ECONNRESET|Request timeout|not reachable/.test(message)) {
            this.started = false;
            this.emit('status-change', { status: WdaStatus.STOPPED, text: message });
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async performScroll(args: any): Promise<any> {
        const points: TrailPoint[] = Array.isArray(args.points) ? args.points : [];
        if (points.length >= 2) {
            return this.rpc('device.io.gesture', { actions: DeviceKitControlRunner.gestureFromTrail(points) });
        }
        // No trail (old client): replay a straight drag with the reported duration.
        const duration = DeviceKitControlRunner.clampDuration(args.duration, 0.25);
        const actions: GestureAction[] = [
            { type: 'press', duration: 0, x: args.from.x, y: args.from.y, button: 0 },
            { type: 'move', duration, x: args.to.x, y: args.to.y, button: 0 },
            { type: 'release', duration: 0.02, x: args.to.x, y: args.to.y, button: 0 },
        ];
        return this.rpc('device.io.gesture', { actions });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async pressButton(name: string): Promise<any> {
        switch (name) {
            case 'home':
            case 'lock':
            case 'volumeUp':
            case 'volumeDown':
                return this.rpc('device.io.button', { button: name });
            case 'back':
                return this.rpc('device.io.gesture', { actions: this.backGesture() });
            case 'appSwitcher':
                return this.rpc('device.io.gesture', { actions: this.appSwitcherGesture() });
            default:
                throw new Error(`Unsupported button "${name}"`);
        }
    }

    // iOS "back" = the system left-edge swipe (works in most apps).
    private backGesture(): GestureAction[] {
        const { height, width } = this.requireScreenSize();
        const y = Math.round(height * 0.5);
        return [
            { type: 'press', duration: 0, x: 2, y, button: 0 },
            { type: 'move', duration: 0.15, x: Math.round(width * 0.45), y, button: 0 },
            { type: 'release', duration: 0.02, x: Math.round(width * 0.45), y, button: 0 },
        ];
    }

    // App switcher = swipe up from the bottom edge and hold (Face ID devices).
    private appSwitcherGesture(): GestureAction[] {
        const { height, width } = this.requireScreenSize();
        const x = Math.round(width * 0.5);
        const yTarget = Math.round(height * 0.45);
        return [
            { type: 'press', duration: 0, x, y: height - 2, button: 0 },
            { type: 'move', duration: 0.25, x, y: yTarget, button: 0 },
            // Second move to the same point = hold the finger before release.
            { type: 'move', duration: 0.35, x, y: yTarget, button: 0 },
            { type: 'release', duration: 0.02, x, y: yTarget, button: 0 },
        ];
    }

    private requireScreenSize(): { width: number; height: number } {
        if (!this.screenSize) {
            throw new Error('DeviceKit screen size is not known yet');
        }
        return this.screenSize;
    }

    /**
     * Replays the recorded mouse trail 1:1: per-segment durations restore the
     * real gesture speed and curve (a fast flick stays a flick - unlike WDA's
     * fixed 0.5s press-and-drag which iOS reads as a long-press).
     */
    private static gestureFromTrail(points: TrailPoint[]): GestureAction[] {
        const actions: GestureAction[] = [];
        const first = points[0];
        // press.duration is the hold-before-move; the agent enforces a 0.05s minimum.
        actions.push({ type: 'press', duration: 0, x: first.x, y: first.y, button: 0 });
        for (let i = 1; i < points.length; i++) {
            const dt = Math.max((points[i].t - points[i - 1].t) / 1000, 0);
            actions.push({
                type: 'move',
                duration: DeviceKitControlRunner.round3(dt),
                x: points[i].x,
                y: points[i].y,
                button: 0,
            });
        }
        const last = points[points.length - 1];
        actions.push({ type: 'release', duration: 0.02, x: last.x, y: last.y, button: 0 });
        return actions;
    }

    private static clampDuration(value: unknown, fallback: number): number {
        const num = typeof value === 'number' && isFinite(value) ? value : fallback;
        return Math.min(Math.max(num, 0.05), 5);
    }

    private static round3(value: number): number {
        return Math.round(value * 1000) / 1000;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async rpc(method: string, params: Record<string, unknown>): Promise<any> {
        const { status, body } = await requestJson(
            'POST',
            `${this.baseUrl}/rpc`,
            { jsonrpc: '2.0', id: ++this.rpcId, method, params },
            RPC_TIMEOUT,
        );
        if (status < 200 || status >= 300) {
            throw new Error(`DeviceKit ${method}: HTTP ${status}`);
        }
        if (body && body.error) {
            const message = body.error.message || JSON.stringify(body.error);
            throw new Error(`DeviceKit ${method}: ${message}`);
        }
        return body ? body.result : undefined;
    }
}

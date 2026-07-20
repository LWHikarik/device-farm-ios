import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { TypedEmitter } from '../../../common/TypedEmitter';
import * as portfinder from 'portfinder';
import { IosControlMethod } from '../../../common/IosControlMethod';
import { WdaStatus } from '../../../common/WdaStatus';
import { AppiumRunner, requestJson } from './AppiumRunner';

export interface WdaRunnerEvents {
    'status-change': { status: WdaStatus; text?: string; code?: number };
    error: Error;
}

// Creating a session may build/launch WebDriverAgent on the device — slow on the first run.
const SESSION_CREATE_TIMEOUT = 300000;
const COMMAND_TIMEOUT = 30000;
// Duration (seconds) used to turn a SCROLL gesture into a WDA drag.
const SCROLL_DURATION_SEC = 0.5;

/**
 * Per-device WebDriverAgent control.
 *
 * Was: an in-process embedding of the bundled `appium-xcuitest-driver@3.62.0`.
 * Now: a thin HTTP (W3C WebDriver) client of a modern, standalone Appium server
 * (see {@link AppiumRunner}). One Appium server hosts many sessions; this class
 * owns exactly one session per device (udid).
 *
 * The WebSocket protocol with the browser (`IosControlMethod`, the response envelope and
 * the `status-change` / `error` events) is intentionally unchanged.
 */
export class WdaRunner extends TypedEmitter<WdaRunnerEvents> {
    protected static TAG = 'WDARunner';
    private static instances: Map<string, WdaRunner> = new Map();
    public static SHUTDOWN_TIMEOUT = 15000;
    private static cachedScreenWidth: Map<string, number> = new Map();

    public static getInstance(udid: string): WdaRunner {
        let instance = this.instances.get(udid);
        if (!instance) {
            instance = new WdaRunner(udid);
            this.instances.set(udid, instance);
        }
        instance.lock();
        return instance;
    }

    protected name: string;
    protected started = false;
    protected starting = false;
    private baseUrl?: string;
    private sessionId?: string;
    private wdaLocalPort = 0;
    private holders = 0;
    protected releaseTimeoutId?: NodeJS.Timeout;

    constructor(private readonly udid: string) {
        super();
        this.name = `[${WdaRunner.TAG}][udid: ${this.udid}]`;
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
            WdaRunner.instances.delete(this.udid);
            void this.deleteSession();
        }, WdaRunner.SHUTDOWN_TIMEOUT);
    }

    // MJPEG video path is no longer served through WDA (video comes from qvh).
    // Kept as a no-op for source compatibility with the (build-time disabled)
    // MjpegProxyFactory.
    public get mjpegPort(): number {
        return 0;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public async request(command: ControlCenterCommand): Promise<any> {
        if (!this.sessionId || !this.baseUrl) {
            return;
        }
        const method = command.getMethod();
        const args = command.getArgs();
        switch (method) {
            case IosControlMethod.GET_SCREEN_WIDTH:
                return this.getScreenWidth();
            case IosControlMethod.CLICK:
                return this.executeMobile('mobile: tap', { x: args.x, y: args.y });
            case IosControlMethod.LONG_PRESS:
                return this.executeMobile('mobile: touchAndHold', {
                    x: args.x,
                    y: args.y,
                    duration: typeof args.duration === 'number' ? Math.min(args.duration, 5) : 0.8,
                });
            case IosControlMethod.PRESS_BUTTON:
                return this.executeMobile('mobile: pressButton', { name: args.name });
            case IosControlMethod.SCROLL:
                // Use the real gesture duration when the client provides one
                // (see SimpleInteractionHandler); WDA replays it as a drag.
                return this.executeMobile('mobile: dragFromToForDuration', {
                    duration:
                        typeof args.duration === 'number' && args.duration > 0
                            ? Math.min(args.duration, 3)
                            : SCROLL_DURATION_SEC,
                    fromX: args.from.x,
                    fromY: args.from.y,
                    toX: args.to.x,
                    toY: args.to.y,
                });
            case IosControlMethod.APPIUM_SETTINGS:
                return this.updateSettings(args.options);
            case IosControlMethod.SEND_KEYS:
                return this.executeMobile('mobile: keys', {
                    keys: Array.isArray(args.keys) ? args.keys : [args.keys],
                });
            default:
                return `Unknown command: ${method}`;
        }
    }

    public async start(): Promise<void> {
        if (this.started || this.starting) {
            return;
        }
        this.starting = true;
        this.emit('status-change', { status: WdaStatus.STARTING });
        try {
            this.baseUrl = await AppiumRunner.getInstance().whenReady();
            this.wdaLocalPort = await portfinder.getPortPromise();
            const capabilities = this.buildCapabilities();
            const { status, body } = await requestJson(
                'POST',
                `${this.baseUrl}/session`,
                { capabilities },
                SESSION_CREATE_TIMEOUT,
            );
            const sessionId = body && body.value && body.value.sessionId;
            if (status < 200 || status >= 300 || !sessionId) {
                const message =
                    (body && body.value && body.value.message) || `Failed to create session (HTTP ${status})`;
                throw new Error(message);
            }
            this.sessionId = sessionId;
            this.started = true;
            this.starting = false;
            this.emit('status-change', { status: WdaStatus.STARTED });
        } catch (error) {
            this.started = false;
            this.starting = false;
            this.emit('error', error instanceof Error ? error : new Error(String(error)));
        }
    }

    public isStarted(): boolean {
        return this.started;
    }

    public release(): void {
        this.unlock();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private buildCapabilities(): any {
        const xcodeOrgId = process.env.WDA_TEAM_ID;
        const xcodeSigningId = process.env.WDA_SIGNING_ID || 'Apple Development';
        const updatedWDABundleId = process.env.WDA_BUNDLE_ID;
        const usePrebuiltWDA = process.env.WDA_USE_PREBUILT === 'true';
        // Real-device WebDriverAgent signing is configured via env so we don't hardcode a
        // developer identity (xcodebuild fails with code 65 when WDA is unsigned):
        //   WDA_TEAM_ID    - Apple Team ID (the cert's OU, e.g. 5GD582Y7Q3)
        //   WDA_SIGNING_ID - signing identity, default "Apple Development"
        //   WDA_BUNDLE_ID  - unique WDA bundle id, e.g. com.<you>.WebDriverAgentRunner
        //   WDA_USE_PREBUILT=true - reuse an already-built+signed WDA (faster)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const alwaysMatch: any = {
            platformName: 'iOS',
            'appium:automationName': 'XCUITest',
            'appium:udid': this.udid,
            'appium:wdaLocalPort': this.wdaLocalPort,
            'appium:usePrebuiltWDA': usePrebuiltWDA,
            'appium:allowProvisioningDeviceRegistration': true,
            'appium:wdaLaunchTimeout': 240000,
            'appium:newCommandTimeout': 300,
        };
        if (xcodeOrgId) {
            alwaysMatch['appium:xcodeOrgId'] = xcodeOrgId;
            alwaysMatch['appium:xcodeSigningId'] = xcodeSigningId;
        }
        if (updatedWDABundleId) {
            alwaysMatch['appium:updatedWDABundleId'] = updatedWDABundleId;
        }
        if (process.env.WS_SCRCPY_DEBUG) {
            alwaysMatch['appium:showXcodeLog'] = true;
        }
        // Optional: silences the "'platformVersion' ('undefined') is not a valid version"
        // warning and avoids version-dependent driver inconsistencies (e.g. WDA_PLATFORM_VERSION=26.5).
        if (process.env.WDA_PLATFORM_VERSION) {
            alwaysMatch['appium:platformVersion'] = process.env.WDA_PLATFORM_VERSION;
        }
        return { alwaysMatch, firstMatch: [{}] };
    }

    private sessionUrl(suffix = ''): string {
        return `${this.baseUrl}/session/${this.sessionId}${suffix}`;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async executeMobile(script: string, args: Record<string, unknown>): Promise<any> {
        const { status, body } = await requestJson(
            'POST',
            this.sessionUrl('/execute/sync'),
            { script, args: [args] },
            COMMAND_TIMEOUT,
        );
        return this.unwrap(status, body);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async updateSettings(settings: Record<string, unknown>): Promise<any> {
        const { status, body } = await requestJson(
            'POST',
            this.sessionUrl('/appium/settings'),
            { settings },
            COMMAND_TIMEOUT,
        );
        return this.unwrap(status, body);
    }

    private async getScreenWidth(): Promise<number> {
        const cached = WdaRunner.cachedScreenWidth.get(this.udid);
        if (cached) {
            return cached;
        }
        let width = 0;
        try {
            // `mobile: deviceScreenInfo` maps to the same getScreenInfo() the old driver used.
            const info = await this.executeMobile('mobile: deviceScreenInfo', {});
            if (info && info.statusBarSize && info.statusBarSize.width > 0) {
                width = info.statusBarSize.width;
            }
        } catch (e) {
            /* fall back to the window rect below */
        }
        if (!width) {
            const { status, body } = await requestJson(
                'GET',
                this.sessionUrl('/window/rect'),
                undefined,
                COMMAND_TIMEOUT,
            );
            const rect = this.unwrap(status, body);
            if (rect && rect.width) {
                width = rect.width;
            }
        }
        if (width) {
            WdaRunner.cachedScreenWidth.set(this.udid, width);
        }
        return width;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private unwrap(status: number, body: any): any {
        if (status >= 200 && status < 300) {
            return body ? body.value : undefined;
        }
        const value = (body && body.value) || {};
        if (status === 404 || value.error === 'invalid session id') {
            this.onSessionLost();
        }
        throw new Error(value.message || `HTTP ${status}`);
    }

    private onSessionLost(): void {
        this.sessionId = undefined;
        this.started = false;
        WdaRunner.cachedScreenWidth.delete(this.udid);
        this.emit('status-change', { status: WdaStatus.STOPPED });
        if (this.holders > 0) {
            void this.start();
        }
    }

    private async deleteSession(): Promise<void> {
        const sessionId = this.sessionId;
        const baseUrl = this.baseUrl;
        this.sessionId = undefined;
        this.started = false;
        this.starting = false;
        if (sessionId && baseUrl) {
            try {
                await requestJson('DELETE', `${baseUrl}/session/${sessionId}`, undefined, COMMAND_TIMEOUT);
            } catch (e) {
                /* best-effort cleanup */
            }
        }
    }
}

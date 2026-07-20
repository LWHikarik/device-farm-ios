import * as portfinder from 'portfinder';
import { ProcessRunner, ProcessRunnerEvents } from '../../services/ProcessRunner';

export class IosVideoBridgeRunner extends ProcessRunner<ProcessRunnerEvents> {
    private static instances: Map<string, IosVideoBridgeRunner> = new Map();
    public static SHUTDOWN_TIMEOUT = 15000;
    public static getInstance(udid: string): IosVideoBridgeRunner {
        let instance = this.instances.get(udid);
        if (!instance) {
            instance = new IosVideoBridgeRunner(udid);
            this.instances.set(udid, instance);
            instance.start();
        }
        instance.lock();
        return instance;
    }
    protected TAG = '[IosVideoBridgeRunner]';
    protected name: string;
    protected cmd = 'ws-qvh';
    protected releaseTimeoutId?: NodeJS.Timeout;
    protected address = '';
    protected started = false;
    private holders = 0;

    constructor(private readonly udid: string) {
        super();
        this.name = `${this.TAG}[udid: ${this.udid}]`;
    }

    public getWebSocketAddress(): string {
        return this.address;
    }

    protected lock(): void {
        if (this.releaseTimeoutId) {
            clearTimeout(this.releaseTimeoutId);
        }
        this.holders++;
    }

    protected unlock(): void {
        this.holders--;
        if (this.holders > 0) {
            return;
        }
        this.releaseTimeoutId = setTimeout(() => {
            super.release();
            IosVideoBridgeRunner.instances.delete(this.udid);
        }, IosVideoBridgeRunner.SHUTDOWN_TIMEOUT);
    }

    protected async getArgs(): Promise<string[]> {
        const port = await portfinder.getPortPromise();
        const host = `127.0.0.1:${port}`;
        this.address = `ws://${host}/ws?stream=${encodeURIComponent(this.udid)}`;
        return [host];
    }

    public async start(): Promise<void> {
        return this.runProcess()
            .then(() => {
                // With WS_SCRCPY_DEBUG set, surface ws-qvh's own logs (device discovery,
                // QT activation, "PING received", libusb/USB errors) into the ws-scrcpy
                // console. Otherwise this output is swallowed and stream failures are silent.
                if (process.env.WS_SCRCPY_DEBUG) {
                    this.on('stdout', (data) => process.stdout.write(`${this.name}[ws-qvh] ${data}`));
                    this.on('stderr', (data) => process.stderr.write(`${this.name}[ws-qvh] ${String(data)}`));
                }
                // Wait for server to start listen on a port
                this.once('stderr', () => {
                    this.started = true;
                    this.emit('started', true);
                });
            })
            .catch((e) => {
                console.error(this.name, e.message);
            });
    }

    public isStarted(): boolean {
        return this.started;
    }

    public release(): void {
        this.unlock();
    }
}

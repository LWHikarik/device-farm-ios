import WS from 'ws';
import { Mw } from '../../mw/Mw';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { IosVideoBridgeRunner } from '../services/IosVideoBridgeRunner';
import { WebsocketProxy } from '../../mw/WebsocketProxy';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ChannelCode } from '../../../common/ChannelCode';
import Util from '../../../app/Util';

export class IosVideoStreamProxy extends Mw {
    public static readonly TAG = 'IosVideoStreamProxy';

    public static processChannel(ws: Multiplexer, code: string, data: ArrayBuffer): Mw | undefined {
        if (code !== ChannelCode.QVHS) {
            return;
        }
        if (!data || data.byteLength < 4) {
            return;
        }
        const buffer = Buffer.from(data);
        const length = buffer.readInt32LE(0);
        const udid = Util.utf8ByteArrayToString(buffer.slice(4, 4 + length));
        return new IosVideoStreamProxy(ws, udid);
    }

    private qvhProcess: IosVideoBridgeRunner;
    private wsProxy?: WebsocketProxy;
    protected name: string;
    constructor(protected ws: Multiplexer, private readonly udid: string) {
        super(ws);
        this.name = `[${IosVideoStreamProxy.TAG}][udid:${this.udid}]`;
        this.qvhProcess = IosVideoBridgeRunner.getInstance(udid);
        this.attachEventListeners();
    }

    private onStarted = (): void => {
        const remote = this.qvhProcess.getWebSocketAddress();
        if (process.env.WS_SCRCPY_DEBUG) {
            console.log(`${this.name} ws-qvh started, proxying client → ${remote}`);
        }
        this.wsProxy = WebsocketProxy.createProxy(this.ws, remote);
        this.ws.addEventListener('close', this.onSocketClose.bind(this));
    };

    private attachEventListeners(): void {
        if (this.qvhProcess.isStarted()) {
            this.onStarted();
        } else {
            this.qvhProcess.once('started', this.onStarted);
        }
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        let command: ControlCenterCommand;
        try {
            command = ControlCenterCommand.fromJSON(event.data.toString());
        } catch (error: any) {
            console.error(`${this.name}, Received message: ${event.data}. Error: ${error.message}`);
            return;
        }
        console.log(`${this.name}, Received message: type:"${command.getType()}", data:${command.getData()}.`);
    }

    protected onSocketClose(): void {
        if (this.wsProxy) {
            this.wsProxy.release();
            delete this.wsProxy;
        }
        this.release();
    }

    public release(): void {
        super.release();
        if (this.qvhProcess) {
            this.qvhProcess.release();
        }
        if (this.wsProxy) {
            this.wsProxy.release();
            delete this.wsProxy;
        }
    }
}

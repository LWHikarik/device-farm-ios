import { StreamReceiver } from '../../client/StreamReceiver';
import { BasePlayer, PlayerClass } from '../../player/BasePlayer';
import { ACTION } from '../../../common/Action';
import { IosStreamReceiver } from './IosStreamReceiver';
import { StreamClient } from './StreamClient';
import { ParamsStream } from '../../../types/ParamsStream';

const TAG = '[IosStreamClient]';

export class IosStreamClient extends StreamClient<ParamsStream> {
    public static ACTION = ACTION.STREAM_WS_QVH;
    protected static players: Map<string, PlayerClass> = new Map<string, PlayerClass>();

    public static start(params: ParamsStream): IosStreamClient {
        return new IosStreamClient(params);
    }

    private readonly streamReceiver: StreamReceiver<ParamsStream>;

    constructor(params: ParamsStream) {
        super(params);

        this.name = `[${TAG}:${this.udid}]`;
        this.udid = this.params.udid;
        let udid = this.udid;
        // Workaround for qvh v0.5-beta
        if (udid.indexOf('-') !== -1) {
            udid = udid.replace('-', '');
            udid = udid + '\0'.repeat(16);
        }
        this.streamReceiver = new IosStreamReceiver({ ...this.params, udid });
        this.startStream();
        this.setTitle(`${this.udid} stream`);
        this.setBodyClass('stream');
    }

    public static get action(): string {
        return IosStreamClient.ACTION;
    }

    public createPlayer(udid: string, playerName?: string): BasePlayer {
        return IosStreamClient.createPlayer(udid, playerName);
    }

    protected onViewVideoResize = (): void => {
        this.runWebDriverAgent();
    };

    public onStop(ev?: string | Event): void {
        super.onStop(ev);
        this.streamReceiver.stop();
    }

    protected startStream(inputPlayer?: BasePlayer): void {
        super.startStream(inputPlayer);
        const player = this.player;
        if (player) {
            player.on('video-view-resize', this.onViewVideoResize);
            this.streamReceiver.on('video', (data) => {
                const STATE = BasePlayer.STATE;
                if (player.getState() === STATE.PAUSED) {
                    player.play();
                }
                if (player.getState() === STATE.PLAYING) {
                    player.pushFrame(new Uint8Array(data));
                }
            });
        }
    }
}

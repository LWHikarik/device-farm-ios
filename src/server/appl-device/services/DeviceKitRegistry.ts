/**
 * Maps an iOS device (udid) to its DeviceKit agent base URL.
 *
 * Single source of truth shared with the video path: ws-qvh reads the same
 * `WS_QVH_DEVICEKIT_PORTS` env ("<udid>=<port>,<udid>=<port>,..."), so video
 * (`GET /h264`) and control (`POST /rpc`) always talk to the same per-device
 * agent. Unmapped udids fall back to `WS_QVH_DEVICEKIT_URL` (default
 * `http://127.0.0.1:12004`) — mirroring ws-qvh. NOTE: with several phones the
 * fallback collides (one agent per port), so keep the map complete.
 *
 * Step 2 (auto port allocation, ws-qvh owning agents) only swaps the backing
 * of this class; callers stay unchanged.
 */
export class DeviceKitRegistry {
    private static portMap?: Map<string, string>;

    // Udids arrive in different shapes: "00008101-000E7482..." (trackers),
    // dash-less and NUL-padded (the qvh v0.5-beta workaround in IosStreamClient).
    // Normalize before lookups.
    public static normalizeUdid(udid: string): string {
        // eslint-disable-next-line no-control-regex
        return udid
            .replace(/\0+$/g, '')
            .replace(/[\s-]+/g, '')
            .toLowerCase();
    }

    private static getPortMap(): Map<string, string> {
        if (this.portMap) {
            return this.portMap;
        }
        const map = new Map<string, string>();
        const raw = process.env.WS_QVH_DEVICEKIT_PORTS || '';
        raw.split(',').forEach((pair) => {
            const idx = pair.indexOf('=');
            if (idx <= 0) {
                return;
            }
            const udid = this.normalizeUdid(pair.slice(0, idx));
            const port = pair.slice(idx + 1).trim();
            if (udid && port) {
                map.set(udid, port);
            }
        });
        this.portMap = map;
        return map;
    }

    public static baseUrl(udid: string): string {
        const port = this.getPortMap().get(this.normalizeUdid(udid));
        if (port) {
            return `http://127.0.0.1:${port}`;
        }
        return process.env.WS_QVH_DEVICEKIT_URL || 'http://127.0.0.1:12004';
    }
}

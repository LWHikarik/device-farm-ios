import { InteractionEvents, InteractionHandler } from './InteractionHandler';
import { BasePlayer } from '../player/BasePlayer';
import ScreenInfo from '../ScreenInfo';
import Position from '../Position';

// A point of the gesture, in video coordinates; `t` is `Date.now()` at capture.
export interface GestureTrailPoint {
    position: Position;
    t: number;
}

export interface TouchHandlerListener {
    performClick: (position: Position) => void;
    performLongPress: (position: Position, duration: number) => void;
    performScroll: (from: Position, to: Position, trail?: GestureTrailPoint[]) => void;
}

const TAG = '[SimpleTouchHandler]';

// Movement below this (video px) is a tap/long-press, above - a scroll gesture.
const TAP_MOVE_LIMIT = 10;
// Holding a tap at least this long turns it into a long-press.
const LONG_PRESS_MS = 500;
// Trail sampling: skip points closer than this in time AND distance, hard cap the size.
const TRAIL_MIN_DT_MS = 16;
const TRAIL_MIN_DIST = 3;
const TRAIL_MAX_POINTS = 64;
// The gesture overlay is transient feedback - keep it subtle.
const OVERLAY_ALPHA = 0.35;

export class SimpleInteractionHandler extends InteractionHandler {
    private startPosition?: Position;
    private endPosition?: Position;
    private startTime = 0;
    private trail: GestureTrailPoint[] = [];
    private static readonly touchEventsNames: InteractionEvents[] = ['mousedown', 'mouseup', 'mousemove'];
    private storage = new Map();

    constructor(player: BasePlayer, private readonly listener: TouchHandlerListener) {
        super(player, SimpleInteractionHandler.touchEventsNames, []);
    }

    protected onInteraction(event: MouseEvent | TouchEvent): void {
        let handled = false;
        if (!(event instanceof MouseEvent)) {
            return;
        }
        if (event.target === this.tag) {
            const screenInfo: ScreenInfo = this.player.getScreenInfo() as ScreenInfo;
            if (!screenInfo) {
                return;
            }
            const events = this.buildTouchEvent(event, screenInfo, this.storage);
            if (events.length > 1) {
                console.warn(TAG, 'Too many events', events);
                return;
            }
            const downEventName = 'mousedown';
            if (events.length === 1) {
                handled = true;
                const position = events[0].position;
                const now = Date.now();
                if (event.type === downEventName) {
                    this.startPosition = position;
                    this.startTime = now;
                    this.trail = [{ position, t: now }];
                } else {
                    if (this.startPosition) {
                        this.endPosition = position;
                        this.recordTrailPoint(position, now);
                    } else {
                        console.warn(TAG, `Received "${event.type}" before "${downEventName}"`);
                    }
                }
                this.drawGestureOverlay();
                if (event.type === 'mouseup') {
                    if (this.startPosition && this.endPosition) {
                        this.clearCanvas();
                        const duration = now - this.startTime;
                        if (this.startPosition.point.distance(this.endPosition.point) < TAP_MOVE_LIMIT) {
                            if (duration >= LONG_PRESS_MS) {
                                this.listener.performLongPress(this.endPosition, duration / 1000);
                            } else {
                                this.listener.performClick(this.endPosition);
                            }
                        } else {
                            this.listener.performScroll(this.startPosition, this.endPosition, this.trail.slice());
                        }
                    }
                }
            }
            if (handled) {
                if (event.cancelable) {
                    event.preventDefault();
                }
                event.stopPropagation();
            }
        }
        if (event.type === 'mouseup') {
            this.startPosition = undefined;
            this.endPosition = undefined;
            this.trail = [];
        }
    }

    private recordTrailPoint(position: Position, now: number): void {
        const last = this.trail[this.trail.length - 1];
        if (!last) {
            return;
        }
        const dt = now - last.t;
        const dist = position.point.distance(last.position.point);
        if ((dt < TRAIL_MIN_DT_MS && dist < TRAIL_MIN_DIST) || this.trail.length >= TRAIL_MAX_POINTS) {
            // Keep the trail ending at the cursor without growing it.
            if (this.trail.length > 1) {
                this.trail[this.trail.length - 1] = { position, t: now };
            }
            return;
        }
        this.trail.push({ position, t: now });
    }

    private drawGestureOverlay(): void {
        if (!this.ctx) {
            return;
        }
        this.clearCanvas();
        this.ctx.save();
        this.ctx.globalAlpha = OVERLAY_ALPHA;
        if (this.startPosition) {
            this.drawPointer(this.startPosition.point);
        }
        if (this.startPosition && this.endPosition) {
            this.drawPointer(this.endPosition.point);
            this.drawLine(this.startPosition.point, this.endPosition.point);
        }
        this.ctx.restore();
    }

    protected onKey(): void {
        throw Error(`${TAG} Unsupported`);
    }
}

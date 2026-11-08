/**
 * Message contract between the MAIN-world inject script (which can see
 * `netflix.*`) and the ISOLATED-world content script (which holds the socket).
 * Both sides use window.postMessage; every message carries this namespace so we
 * ignore unrelated page traffic.
 */
import { ContentInfo } from "./protocol";

export const NS = "watchparty";

export type PlaybackAction = "play" | "pause" | "seek";

/** inject -> content: the local player did something. */
export interface LocalPlaybackMsg {
  ns: typeof NS;
  dir: "fromPage";
  kind: "playback";
  action: PlaybackAction;
  position: number; // seconds
  content: ContentInfo | null;
  /** Local wall-clock time (ms) `position` was read at. */
  sampledAt: number;
}

/** inject -> content: periodic state sample (for host drift broadcasts). */
export interface LocalStateMsg {
  ns: typeof NS;
  dir: "fromPage";
  kind: "state";
  position: number;
  playing: boolean;
  content: ContentInfo | null;
  /** True while the player can't keep playing — see PlayerAdapter.isBuffering. */
  buffering: boolean;
  /** Local wall-clock time (ms) `position` was read at. */
  sampledAt: number;
}

/** inject -> content: player readiness. */
export interface ReadyMsg {
  ns: typeof NS;
  dir: "fromPage";
  kind: "ready";
  ready: boolean;
}

/** content -> inject: apply a remote command to the local player. */
export interface ApplyMsg {
  ns: typeof NS;
  dir: "toPage";
  kind: "apply";
  action: PlaybackAction;
  position: number;
}

/** content -> inject: nudge playback speed to close a small drift. */
export interface RateMsg {
  ns: typeof NS;
  dir: "toPage";
  kind: "rate";
  rate: number;
}

export type FromPage = LocalPlaybackMsg | LocalStateMsg | ReadyMsg;
export type ToPage = ApplyMsg | RateMsg;

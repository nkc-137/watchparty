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

export type FromPage = LocalPlaybackMsg | LocalStateMsg | ReadyMsg;
export type ToPage = ApplyMsg;

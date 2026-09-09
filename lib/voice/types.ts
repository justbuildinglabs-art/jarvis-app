// The voice client's listener and payload shapes. Types only, so a component
// can be typed against the client without importing the browser singleton.

export type SpeakingListener = (speaking: boolean) => void;
export type LogListener = (cls: string, text: string) => void;
export type PanelsListener = (panels: string[]) => void;
export type DeliverableListener = (path: string, label: string) => void;
export type ListeningListener = (listening: boolean) => void;

export interface Reveal {
  kind: "doc" | "link";
  target: string;
  label: string;
  at: number; // char offset into the reply where its sentence starts
}
export type RevealListener = (r: Reveal) => void;

export interface Utterance {
  text: string;
  reveals?: Reveal[];
}

// post-wake utterances that just mean "never mind" — already barged in, drop
const DISMISS_RE = /^(stop|cancel|never ?mind|nothing|no|nope|shut up|quiet)[\s.!,]*$/i;

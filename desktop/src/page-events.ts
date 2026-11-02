// Menu -> page messages. The renderer has no preload and no IPC: the main process runs one fixed
// line in the viewer page that dispatches a named window event, with a detail taken from a closed
// list (never text from elsewhere), so this is the whole surface.

export const PICK_EVENT = "deltadeck:pick-folder"; // web/src/components/root-switcher.tsx PICK_FOLDER_EVENT
export const FIND_EVENT = "deltadeck:find"; // web/src/lib/find/registry.ts FIND_EVENT

export const FIND_ACTIONS = ["open", "next", "prev"] as const;
export type FindAction = (typeof FIND_ACTIONS)[number];

/** The script for "Open Folder…": the page runs its own folder flow. */
export function pickFolderScript(): string {
  return `window.dispatchEvent(new Event(${JSON.stringify(PICK_EVENT)})); 0`;
}

/** The script for Edit > Find / Find Next / Find Previous; throws on anything else. */
export function findScript(action: FindAction): string {
  if (!(FIND_ACTIONS as readonly string[]).includes(action)) throw new Error(`bad find action: ${String(action)}`);
  return `window.dispatchEvent(new CustomEvent(${JSON.stringify(FIND_EVENT)}, { detail: ${JSON.stringify(action)} })); 0`;
}

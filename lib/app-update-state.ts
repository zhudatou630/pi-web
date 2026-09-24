declare global {
  var __piWebUpdating: boolean | undefined;
}

export function assertAppNotUpdating(): void {
  if (globalThis.__piWebUpdating) throw new Error("Pi Web is updating. Please wait for the restart.");
}

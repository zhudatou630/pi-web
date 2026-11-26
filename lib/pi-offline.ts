/** Match the embedded SDK's ModelRuntime: even an empty PI_OFFLINE disables network refresh. */
export function isPiOffline(): boolean {
  return process.env.PI_OFFLINE !== undefined;
}

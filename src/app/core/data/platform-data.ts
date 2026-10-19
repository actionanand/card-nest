/** Build-replaced Android cleanup hook. No native SMS code enters the web graph. */
export async function clearPlatformDiscovery(): Promise<void> {
  /* No platform queue on web. */
}

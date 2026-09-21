import open from "open";

/** Best-effort browser open; never throws. Returns false so caller can print the URL. */
export async function openInBrowser(url: string): Promise<boolean> {
  try {
    await open(url);
    return true;
  } catch {
    return false;
  }
}

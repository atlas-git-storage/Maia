/**
 * Find sidecar subtitle files for a video, the way media players do:
 *   - same directory, same stem:  Movie.srt, Movie.en.srt, Movie.forced.en.vtt
 *   - a "Subs" folder beside it:  Subs/English.srt (when it's the only video in
 *     the directory), or Subs/<stem>/2_English.srt / Subs/<stem>.en.srt (TV packs)
 */

import type { ManifestEntry } from "./types.ts";
import { extOf, isSubtitle, isVideo } from "./mime.ts";

export interface SubtitleFile {
  path: string;
  /** Short label for the track menu, e.g. "en" or "2_English". */
  label: string;
}

function stripExt(name: string): string {
  const ext = extOf(name);
  return ext ? name.slice(0, -(ext.length + 1)) : name;
}

export function findSubtitles(entries: ManifestEntry[], videoPath: string): SubtitleFile[] {
  const dir = videoPath.slice(0, videoPath.lastIndexOf("/") + 1);
  const stem = stripExt(videoPath.slice(dir.length));
  const onlyVideo =
    entries.filter((e) =>
      e.p.startsWith(dir) && !e.p.slice(dir.length).includes("/") && isVideo(e.p)
    ).length === 1;

  const out: SubtitleFile[] = [];
  for (const e of entries) {
    if (!isSubtitle(e.p) || !e.p.startsWith(dir)) continue;
    const rest = stripExt(e.p.slice(dir.length));
    if (!rest.includes("/")) {
      if (rest === stem) out.push({ path: e.p, label: "default" });
      else if (rest.startsWith(stem + ".")) {
        out.push({ path: e.p, label: rest.slice(stem.length + 1) });
      }
    } else if (/^subs\//i.test(rest)) {
      const sub = rest.slice("subs/".length);
      if (sub.startsWith(stem)) {
        out.push({
          path: e.p,
          label: sub.slice(stem.length).replace(/^[/._ -]+/, "") || "default",
        });
      } else if (onlyVideo) {
        out.push({ path: e.p, label: sub });
      }
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

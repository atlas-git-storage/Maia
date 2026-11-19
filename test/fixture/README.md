# Test fixtures

`subs.mkv`: 9 s of 16x16 H.264 with two embedded subtitle tracks (track 2: SRT, `eng`, "English";
track 3: ASS, `fre`) and ~1 s clusters. ffmpeg writes CRC-32 elements in clusters, which the scanner
must handle. Regenerate with:

```sh
ffmpeg -f lavfi -i "color=c=red:s=16x16:r=5:d=9" -i a.srt -i b.ass \
  -map 0 -map 1 -map 2 -c:v libx264 -g 5 -c:s:0 srt -c:s:1 ass \
  -metadata:s:s:0 language=eng -metadata:s:s:0 title=English -metadata:s:s:1 language=fre \
  -cluster_time_limit 1000 subs.mkv
```

with the cues listed in `EXPECTED` in `test/mkv_test.ts`.

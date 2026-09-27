import { describe, expect, it } from "vitest";
import { youtubePlayerPath } from "./embeds";

describe("YouTube player links", () => {
  it.each([
    ["https://www.youtube.com/watch?v=gJrjgg1KVL4", "gJrjgg1KVL4"],
    ["https://youtu.be/qw--VYLpxG4?si=tracking", "qw--VYLpxG4"],
    ["https://youtube.com/embed/-RDyEFvnTXI", "-RDyEFvnTXI"],
    ["https://youtube.com/shorts/QkdkLdMBuL0", "QkdkLdMBuL0"],
    ["http://youtu.be/QkdkLdMBuL0?t=90", "QkdkLdMBuL0?start=90"],
    ["https://youtu.be/QkdkLdMBuL0?t=1h2m3s", "QkdkLdMBuL0?start=3723"],
    ["https://youtube.com/watch?v=QkdkLdMBuL0&t=20&start=10", "QkdkLdMBuL0?start=10"],
    ["https://youtu.be/QkdkLdMBuL0?start=0", "QkdkLdMBuL0"],
    ["https://youtu.be/QkdkLdMBuL0?start=4294967295", "QkdkLdMBuL0?start=4294967295"],
    ["https://youtu.be/QkdkLdMBuL0?t=4294967296", "QkdkLdMBuL0"],
    ["https://youtu.be/QkdkLdMBuL0?t=%22%3E%3Cscript%3E", "QkdkLdMBuL0"],
  ])("normalizes %s", (link, path) => {
    expect(youtubePlayerPath(link)).toBe(path);
  });

  it.each([
    null,
    "",
    "not a URL",
    "https://vimeo.com/123456789",
    "https://youtube.com.evil.example/watch?v=QkdkLdMBuL0",
    "https://evil.example/youtube.com/watch?v=QkdkLdMBuL0",
    "https://youtube.com@evil.example/watch?v=QkdkLdMBuL0",
    "https://user:password@youtube.com/watch?v=QkdkLdMBuL0",
    "https://youtube.com:9999/watch?v=QkdkLdMBuL0",
    "javascript://youtube.com/watch?v=QkdkLdMBuL0",
    "https://youtube.com/watch",
    "https://youtube.com/watch?v=too-short",
    "https://youtu.be/QkdkLdMBuL0/extra",
    "https://youtube.com/embed/%22%3E%3Cscript%3E",
  ])("rejects unsupported links: %s", (link) => {
    expect(youtubePlayerPath(link)).toBeNull();
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { embedSrc } from "../dist/embeds.js";

test("allowlisted players map to a rebuilt src", () => {
  const yt = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://m.youtube.com/shorts/dQw4w9WgXcQ",
    "http://youtube.com/embed/dQw4w9WgXcQ",
  ])
    assert.equal(embedSrc(url), yt, url);

  assert.equal(
    embedSrc("https://docs.google.com/presentation/d/1AbC-_x/edit#slide=id.p"),
    "https://docs.google.com/presentation/d/1AbC-_x/embed",
  );
  assert.equal(
    embedSrc(
      "https://docs.google.com/presentation/d/e/2PACX-1vQ/pub?start=false",
    ),
    "https://docs.google.com/presentation/d/e/2PACX-1vQ/embed",
  );
  assert.equal(
    embedSrc(" https://codepen.io/ort-tic/pen/abcXYZ "),
    "https://codepen.io/ort-tic/embed/abcXYZ?default-tab=result",
  );
});

test("anything else is refused", () => {
  for (const url of [
    "https://youtube.com.evil.io/watch?v=dQw4w9WgXcQ",
    "https://evilyoutube.com/watch?v=dQw4w9WgXcQ",
    "javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ%22onload",
    "https://www.youtube.com/channel/abc",
    "https://docs.google.com/document/d/1AbC/edit",
    "https://docs.google.com/presentation/d/../edit",
    "https://codepen.io/ort-tic/details/abc",
    "https://vimeo.com/123",
    "not a url",
    "",
  ])
    assert.equal(embedSrc(url), null, url);
});

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { App } from "./App"
import { resolveHomepageSection, resolveRendererRole } from "./renderer/roles"

test("role resolution permits only supported renderer roles", () => {
  assert.equal(resolveRendererRole("?role=overlay"), "overlay")
  assert.equal(resolveRendererRole("?role=homepage"), "homepage")
  assert.equal(resolveRendererRole("?role=<script>"), "homepage")
  assert.equal(resolveRendererRole("?role=overlay&role=homepage"), "overlay")
  assert.equal(resolveRendererRole(""), "homepage")
})

test("homepage section hash routing has a safe workspace fallback", () => {
  assert.equal(resolveHomepageSection("#activity"), "activity")
  assert.equal(resolveHomepageSection("#invalid"), "workspace")
})

test("homepage surface renders as the default shell", () => {
  const markup = renderToStaticMarkup(<App search="" />)
  assert.match(markup, /data-renderer-role="homepage"/)
  assert.match(markup, /Start from the work in front of you\./)
})

test("overlay surface renders from the explicit role", () => {
  const markup = renderToStaticMarkup(<App search="?role=overlay" />)
  assert.match(markup, /data-renderer-role="overlay"/)
  assert.match(markup, /Listening for context/)
})

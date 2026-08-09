import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CdpClient,
  assertEditorIsReachable,
  createPage,
  findChromeExecutable,
  waitForDevToolsUrl
} from "./comment-rail-editor-browser-regression.test.mjs";

const editorUrl =
  process.env.PATCHMARK_INTERACTION_URL ??
  "http://127.0.0.1:3117/control-interaction-regression";
const artifactRoot =
  process.env.PATCHMARK_INTERACTION_ARTIFACT_ROOT ??
  mkdtempSync(join(tmpdir(), "patchmark-interaction-artifacts-"));

mkdirSync(artifactRoot, { recursive: true });

async function runBrowserRegression() {
  const chromePath =
    process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();

  if (!chromePath) {
    throw new Error(
      "Chrome was not found. Set PATCHMARK_CHROME_PATH to run the browser interaction regression."
    );
  }

  await assertEditorIsReachable(editorUrl);

  const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-control-chrome-"));
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-features=Translate,MediaRouter",
      "about:blank"
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  let client;

  try {
    const browserWsUrl = await waitForDevToolsUrl(chrome);
    const pageWsUrl = await createPage(browserWsUrl, editorUrl);

    client = await CdpClient.connect(pageWsUrl);
    await client.call("Page.enable");
    await client.call("Runtime.enable");
    await assertDesktopStates(client);
    await assertTouchStates(client);
    await captureDarkPreferenceLimitation(client);
    console.log(`Interaction screenshots: ${artifactRoot}`);
    console.log("Control interaction browser tests passed.");
  } finally {
    await client?.close();
    chrome.kill("SIGTERM");
    for (let attempt = 0; attempt < 20 && chrome.exitCode === null; attempt += 1) {
      await delay(50);
    }
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      await delay(100);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        rmSync(userDataDir, { force: true, recursive: true });
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await delay(100);
      }
    }
  }
}

async function assertDesktopStates(pageClient) {
  await setViewport(pageClient, { height: 1000, mobile: false, width: 1440 });
  await pageClient.call("Emulation.setTouchEmulationEnabled", {
    enabled: false
  });
  await pageClient.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
    media: "screen"
  });
  await navigateAndPrepare(pageClient);

  const media = await readMediaState(pageClient);
  assert.equal(media.hover, true, "Desktop fixture should support hover");
  assert.equal(media.fine, true, "Desktop fixture should use a fine pointer");

  await capture(pageClient, "01-desktop-control-variants.png");

  const defaultState = await readControlState(pageClient, "normal");
  const normalPoint = await controlCenter(pageClient, "normal");
  await moveMouse(pageClient, normalPoint);
  const hoverState = await readControlState(pageClient, "normal");

  assert.notEqual(
    hoverState.backgroundImage,
    defaultState.backgroundImage,
    "Hover-capable pointers should receive visible hover feedback"
  );
  await capture(pageClient, "02-desktop-hover.png");

  await mouseDown(pageClient, normalPoint);
  const pressedState = await readControlState(pageClient, "normal");
  assert.match(
    pressedState.backgroundImage,
    /rgba\(22, 35, 29, 0\.14\)/,
    "Pointer-down should expose the pressed overlay before release"
  );
  await capture(pageClient, "03-desktop-held-down.png");
  await mouseUp(pageClient, normalPoint);
  await moveMouse(pageClient, { x: 1400, y: 980 });

  const releasedState = await readControlState(pageClient, "normal");
  assert.equal(
    releasedState.backgroundImage,
    defaultState.backgroundImage,
    "Moving away after release should restore the ordinary default state"
  );

  await evaluate(pageClient, {
    expression: `(() => {
      document.body.tabIndex = -1;
      document.body.focus();
      return document.activeElement === document.body;
    })()`
  });
  await pressKey(pageClient, "Tab", 9);
  const focused = await readFocusedState(pageClient);
  assert.equal(focused.control, "normal", "Tab should reach the first control");
  assert.equal(
    focused.outlineStyle,
    "solid",
    "Keyboard focus should have a visible outline"
  );
  assert.equal(focused.outlineWidth, "2px");
  await capture(pageClient, "04-desktop-focus-visible.png");

  await evaluate(pageClient, {
    expression: `(() => {
      const control = document.querySelector("[data-control='normal']");
      control.focus();
      return document.activeElement === control;
    })()`
  });
  const normalActivationsBeforeKeyboard = await readActivationCount(
    pageClient,
    "normal"
  );
  await pressKey(pageClient, "Enter", 13);
  assert.equal(
    await readActivationCount(pageClient, "normal"),
    normalActivationsBeforeKeyboard + 1,
    "Enter should activate a focused button"
  );

  await pressKey(pageClient, "Tab", 9);
  await pressKey(pageClient, "Tab", 9);
  await pressKey(pageClient, "Tab", 9);
  assert.equal(
    (await readFocusedState(pageClient)).control,
    "toggle",
    "Tab order should reach the semantic toggle"
  );
  const toggleBefore = await readPressedState(pageClient, "toggle");
  await pressKey(pageClient, " ", 32);
  const toggleAfter = await readPressedState(pageClient, "toggle");
  assert.notEqual(
    toggleAfter,
    toggleBefore,
    "Space should activate a focused toggle"
  );

  const selectedPoint = await controlCenter(pageClient, "selected");
  const selectedBefore = await readControlState(pageClient, "selected");
  assert.equal(selectedBefore.ariaPressed, "true");
  assert.notEqual(selectedBefore.boxShadow, "none");
  await moveMouse(pageClient, selectedPoint);
  await mouseDown(pageClient, selectedPoint);
  const selectedPressed = await readControlState(pageClient, "selected");
  assert.match(selectedPressed.backgroundImage, /rgba\(22, 35, 29, 0\.14\)/);
  await capture(pageClient, "05-desktop-selected-and-pressed.png");
  await mouseUp(pageClient, selectedPoint);
  assert.equal(
    await readPressedState(pageClient, "selected"),
    true,
    "Selected state must persist after pointer release"
  );

  const disabledPoint = await controlCenter(pageClient, "disabled");
  await clickMouse(pageClient, disabledPoint);
  assert.equal(
    await readActivationCount(pageClient, "disabled"),
    0,
    "Disabled controls must not activate"
  );

  const loadingPoint = await controlCenter(pageClient, "loading");
  await clickMouse(pageClient, loadingPoint);
  await clickMouse(pageClient, loadingPoint);
  const loadingState = await readControlState(pageClient, "loading");
  assert.equal(loadingState.ariaBusy, "true");
  assert.equal(loadingState.disabled, true);
  assert.equal(
    await readActivationCount(pageClient, "loading"),
    1,
    "Loading controls must reject duplicate activation"
  );
  await capture(pageClient, "06-desktop-loading-disabled.png");
  await delay(900);
  assert.equal((await readControlState(pageClient, "loading")).ariaBusy, "false");
}

async function assertTouchStates(pageClient) {
  await pageClient.call("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1
  });
  await setViewport(pageClient, { height: 820, mobile: true, width: 390 });
  await navigateAndPrepare(pageClient);

  const media = await readMediaState(pageClient);
  assert.equal(media.hover, false, "Touch fixture must not expose hover");
  assert.equal(media.coarse, true, "Touch fixture should use a coarse pointer");

  const normalPoint = await controlCenter(pageClient, "normal");
  const defaultState = await readControlState(pageClient, "normal");
  await moveMouse(pageClient, normalPoint, "pen");
  await mouseDown(pageClient, normalPoint, "pen");
  await delay(50);
  const pressedState = await readControlState(pageClient, "normal");
  assert.match(
    pressedState.backgroundImage,
    /rgba\(22, 35, 29, 0\.14\)/,
    "Touch-down should expose the pressed overlay before release"
  );
  await capture(pageClient, "07-mobile-held-down.png");
  await mouseUp(pageClient, normalPoint, "pen");
  await delay(120);

  const releasedState = await readControlState(pageClient, "normal");
  assert.equal(
    releasedState.backgroundImage,
    defaultState.backgroundImage,
    "Touch release must not leave a sticky hover overlay"
  );
  await capture(pageClient, "08-mobile-after-release-no-stuck-hover.png");
}

async function captureDarkPreferenceLimitation(pageClient) {
  await pageClient.call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await setViewport(pageClient, { height: 1000, mobile: false, width: 1440 });
  await pageClient.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
    media: "screen"
  });
  await navigateAndPrepare(pageClient);

  const colorScheme = await evaluate(pageClient, {
    expression: "getComputedStyle(document.documentElement).colorScheme"
  });
  assert.equal(
    colorScheme,
    "light",
    "Patchmark currently declares a light-only application theme"
  );
  await capture(pageClient, "09-dark-preference-light-theme-limitation.png");
}

async function navigateAndPrepare(pageClient) {
  await pageClient.call("Page.navigate", { url: editorUrl });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await evaluate(pageClient, {
      expression: `Boolean(document.querySelector("[data-control-fixture-ready='true']"))`
    });
    if (ready) {
      await evaluate(pageClient, {
        expression: `(() => {
          window.scrollTo(0, 0);
          document.body.tabIndex = -1;
          document.body.focus();
          return true;
        })()`
      });
      return;
    }
    await delay(50);
  }

  throw new Error("Timed out waiting for the interaction-state fixture.");
}

async function setViewport(pageClient, { height, mobile, width }) {
  await pageClient.call("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height,
    mobile,
    screenHeight: height,
    screenWidth: width,
    width
  });
}

async function readMediaState(pageClient) {
  return await evaluate(pageClient, {
    expression: `({
      coarse: matchMedia("(pointer: coarse)").matches,
      fine: matchMedia("(pointer: fine)").matches,
      hover: matchMedia("(hover: hover)").matches
    })`
  });
}

async function readControlState(pageClient, control) {
  return await evaluate(pageClient, {
    expression: `(() => {
      const control = document.querySelector(${JSON.stringify(
        `[data-control="${control}"]`
      )});
      const style = getComputedStyle(control);
      return {
        ariaBusy: control.getAttribute("aria-busy"),
        ariaPressed: control.getAttribute("aria-pressed"),
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        disabled: control.disabled,
        opacity: style.opacity,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth
      };
    })()`
  });
}

async function readFocusedState(pageClient) {
  return await evaluate(pageClient, {
    expression: `(() => {
      const active = document.activeElement;
      const style = getComputedStyle(active);
      return {
        control: active?.getAttribute("data-control"),
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth
      };
    })()`
  });
}

async function readPressedState(pageClient, control) {
  return await evaluate(pageClient, {
    expression: `document.querySelector(${JSON.stringify(
      `[data-control="${control}"]`
    )})?.getAttribute("aria-pressed") === "true"`
  });
}

async function readActivationCount(pageClient, control) {
  return await evaluate(pageClient, {
    expression: `Number(document.querySelector(${JSON.stringify(
      `[data-control="${control}"]`
    )})?.getAttribute("data-activation-count") ?? "0")`
  });
}

async function controlCenter(pageClient, control) {
  return await evaluate(pageClient, {
    expression: `(() => {
      const rect = document.querySelector(${JSON.stringify(
        `[data-control="${control}"]`
      )}).getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`
  });
}

async function moveMouse(pageClient, point, pointerType = "mouse") {
  await pageClient.call("Input.dispatchMouseEvent", {
    pointerType,
    type: "mouseMoved",
    x: point.x,
    y: point.y
  });
}

async function mouseDown(pageClient, point, pointerType = "mouse") {
  await pageClient.call("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    clickCount: 1,
    pointerType,
    type: "mousePressed",
    x: point.x,
    y: point.y
  });
}

async function mouseUp(pageClient, point, pointerType = "mouse") {
  await pageClient.call("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType,
    type: "mouseReleased",
    x: point.x,
    y: point.y
  });
}

async function clickMouse(pageClient, point) {
  await moveMouse(pageClient, point);
  await mouseDown(pageClient, point);
  await mouseUp(pageClient, point);
}

async function pressKey(pageClient, key, windowsVirtualKeyCode) {
  const code = key === " " ? "Space" : key;
  const text = key === "Enter" ? "\r" : key === " " ? " " : undefined;
  await pageClient.call("Input.dispatchKeyEvent", {
    code,
    key,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    type: "rawKeyDown",
    windowsVirtualKeyCode
  });
  if (text) {
    await pageClient.call("Input.dispatchKeyEvent", {
      key,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
      text,
      type: "char",
      unmodifiedText: text,
      windowsVirtualKeyCode
    });
  }
  await pageClient.call("Input.dispatchKeyEvent", {
    code,
    key,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    type: "keyUp",
    windowsVirtualKeyCode
  });
}

async function capture(pageClient, fileName) {
  const result = await pageClient.call("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true
  });
  writeFileSync(join(artifactRoot, fileName), Buffer.from(result.data, "base64"));
}

async function evaluate(pageClient, { expression }) {
  const result = await pageClient.call("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    );
  }
  return result.result.value;
}

await runBrowserRegression();

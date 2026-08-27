const commonDirectives = Object.freeze([
  "default-src 'self'",
  "script-src-attr 'none'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "manifest-src 'self'",
  "require-trusted-types-for 'script'"
]);

export const RADIX_SELECT_VIEWPORT_STYLE =
  "[data-radix-select-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-select-viewport]::-webkit-scrollbar{display:none}";
export const RADIX_SELECT_VIEWPORT_STYLE_SHA256 =
  "sha256-441zG27rExd4/il+NvIqyL8zFx5XmyNQtE381kSkUJk=";

export function normalProductionPolicy(nonce) {
  return Object.freeze({
    name: "normal_production",
    trusted_type_policies: Object.freeze(["default", "nextjs#bundler"]),
    header: [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "script-src-attr 'none'",
      `style-src 'self' 'nonce-${nonce}' '${RADIX_SELECT_VIEWPORT_STYLE_SHA256}'`,
      ...commonDirectives.slice(2, -1),
      "trusted-types default nextjs#bundler",
      "require-trusted-types-for 'script'"
    ].join("; ")
  });
}

export function optimizedCollaborationPolicy(nonce) {
  return Object.freeze({
    name: "optimized_collaboration_test_only",
    trusted_type_policies: Object.freeze(["patchmark#optimized-bundler"]),
    header: [
      "default-src 'self'",
      `script-src 'nonce-${nonce}' 'strict-dynamic'`,
      "script-src-attr 'none'",
      "style-src 'self'",
      ...commonDirectives.slice(2, -1),
      "trusted-types patchmark#optimized-bundler",
      "require-trusted-types-for 'script'"
    ].join("; ")
  });
}

export function instrumentPolicyHtml(html, nonce, extraBootstrapSource = "") {
  const bootstrap = `<script nonce="${nonce}">${policyInstrumentationSource()}${extraBootstrapSource}</script>`;
  const withNonces = html
    .replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`)
    .replace(/<style(?![^>]*\bnonce=)/gi, `<style nonce="${nonce}"`);
  return withNonces.replace(/<head([^>]*)>/i, `<head$1>${bootstrap}`);
}

export function validateNormalProductionTrustedHtml(value) {
  if (value !== RADIX_SELECT_VIEWPORT_STYLE) {
    throw new TypeError("TrustedHTML input is outside the fixed Radix Select viewport-style boundary.");
  }
  return value;
}

export function validateNormalProductionScriptUrl(value, locationValue = globalThis.location) {
  if (!locationValue) throw new TypeError("Next production chunk URL requires a browser location.");
  const candidate = new URL(value, locationValue.href);
  const loopbackHttp = candidate.protocol === "http:" && /^(?:127\.0\.0\.1|localhost|\[::1\])$/.test(candidate.hostname);
  if (
    (candidate.protocol !== "https:" && !loopbackHttp) ||
    candidate.origin !== locationValue.origin ||
    candidate.username ||
    candidate.password ||
    candidate.search ||
    candidate.hash ||
    !/^\/_next\/static\/chunks\/[A-Za-z0-9_./-]+\.js$/.test(candidate.pathname)
  ) {
    throw new TypeError("Next production script URL is outside the fixed same-origin chunk boundary.");
  }
  return candidate.href;
}

export function normalProductionTrustedTypesSource() {
  return `(() => {
    if (!globalThis.trustedTypes) return;
    const accepted = ${JSON.stringify(RADIX_SELECT_VIEWPORT_STYLE)};
    const createPolicy = globalThis.trustedTypes.createPolicy.bind(globalThis.trustedTypes);
    globalThis.trustedTypes.createPolicy = (name, rules) => createPolicy(name, name === "nextjs#bundler" ? {
      createScriptURL(value) {
        const candidate = new URL(value, location.href);
        const loopbackHttp = candidate.protocol === "http:" && /^(?:127\\.0\\.0\\.1|localhost|\\[::1\\])$/.test(candidate.hostname);
        if ((candidate.protocol !== "https:" && !loopbackHttp) || candidate.origin !== location.origin || candidate.username || candidate.password || candidate.search || candidate.hash || !/^\\/_next\\/static\\/chunks\\/[A-Za-z0-9_./-]+\\.js$/.test(candidate.pathname)) {
          throw new TypeError("Next production script URL is outside the fixed same-origin chunk boundary.");
        }
        return candidate.href;
      }
    } : rules);
    globalThis.trustedTypes.createPolicy("default", {
      createHTML(value) {
        if (value !== accepted) throw new TypeError("TrustedHTML input is outside the fixed Radix Select viewport-style boundary.");
        return value;
      }
    });
  })();`;
}

export function policyInstrumentationSource() {
  return `(() => {
    const policyEvents = [];
    const runtimeEvents = [];
    const consoleEvents = [];
    const trustedTypePolicies = [];
    Object.defineProperties(window, {
      __patchmarkHc3Slice5PolicyEvents: { value: policyEvents, configurable: false },
      __patchmarkHc3Slice5RuntimeEvents: { value: runtimeEvents, configurable: false },
      __patchmarkHc3Slice5ConsoleEvents: { value: consoleEvents, configurable: false },
      __patchmarkHc3Slice5TrustedTypePolicies: { value: trustedTypePolicies, configurable: false }
    });
    if (globalThis.trustedTypes) {
      const createPolicy = globalThis.trustedTypes.createPolicy.bind(globalThis.trustedTypes);
      globalThis.trustedTypes.createPolicy = (name, rules) => {
        trustedTypePolicies.push(String(name));
        return createPolicy(name, rules);
      };
    }
    addEventListener("securitypolicyviolation", (event) => policyEvents.push(Object.freeze({
      blocked_uri: /^(?:self|inline|eval|wasm-eval|trusted-types-policy|trusted-types-sink)$/.test(event.blockedURI)
        ? event.blockedURI
        : (() => { try { const url = new URL(event.blockedURI, location.href); return url.origin === location.origin ? url.pathname : url.origin; } catch { return "redacted"; } })(),
      source_path: (() => { try { const url = new URL(event.sourceFile, location.href); return url.origin === location.origin ? url.pathname : url.origin; } catch { return "redacted"; } })(),
      line_number: event.lineNumber,
      column_number: event.columnNumber,
      disposition: event.disposition,
      effective_directive: event.effectiveDirective,
      status_code: event.statusCode
    })));
    addEventListener("error", (event) => runtimeEvents.push(Object.freeze({
      kind: "error",
      name: event.error?.name ?? "Error",
      source_path: (() => { try { const url = new URL(event.filename, location.href); return url.origin === location.origin ? url.pathname : url.origin; } catch { return "redacted"; } })(),
      line_number: event.lineno,
      column_number: event.colno,
      stack_frames: String(event.error?.stack ?? "").split("\\n").slice(1, 9).map((frame) => frame.replaceAll(location.origin, ""))
    })));
    addEventListener("unhandledrejection", (event) => runtimeEvents.push(Object.freeze({
      kind: "rejection",
      name: event.reason?.name ?? "Error"
    })));
    for (const method of ["error", "warn"]) {
      const original = console[method].bind(console);
      console[method] = (...values) => {
        consoleEvents.push(Object.freeze({ kind: method, value_types: values.map((value) => typeof value) }));
        original(...values);
      };
    }
  })();`;
}

export function assertPolicyShape(policy) {
  if (policy.header.includes("'unsafe-eval'")) throw new Error("Policy must not allow unsafe-eval.");
  if (/script-src[^;]*'unsafe-inline'/.test(policy.header)) throw new Error("Policy must not allow arbitrary inline script.");
  for (const directive of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "require-trusted-types-for 'script'"]) {
    if (!policy.header.includes(directive)) throw new Error(`Policy is missing ${directive}.`);
  }
  return true;
}

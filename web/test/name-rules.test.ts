import { test } from "node:test";
import assert from "node:assert/strict";

import type { AppConfig } from "../src/lib/api.ts";
import { nameRules, validateName } from "../src/lib/name-rules.ts";

const denied = (name: string, config: AppConfig | null) => validateName(name, nameRules(config))?.startsWith("Matches the deny list") ?? false;

test("built-in deny: .env files, not their templates nor credentials.py", () => {
  for (const n of [".env", ".ENV", ".env.local", ".env.production"]) assert.ok(denied(n, null), n);
  for (const n of [".env.example", ".env.local.sample", ".env.template", "credentials.py", "token_utils.ts"]) {
    assert.ok(!denied(n, null), n);
  }
});

test("a --deny pattern is never lifted by the template exceptions", () => {
  const config = {
    deny_patterns: [".env", ".env.*", "*.example"],
    deny_except_patterns: [".env*.example", ".env*.sample", ".env*.template"],
    deny_lifted_patterns: [".env", ".env.*"],
  } as AppConfig;
  assert.ok(denied(".env.example", config));
  assert.ok(!denied(".env.sample", config));
  // --deny '.env.*': the server leaves it out of the lifted list, so templates stay protected
  const strict = { ...config, deny_patterns: [".env", ".env.*", ".env.*"], deny_lifted_patterns: [".env"] } as AppConfig;
  assert.ok(denied(".env.example", strict) && denied(".env.local.sample", strict));
});

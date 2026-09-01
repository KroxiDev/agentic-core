# Golden Rules

1. Understanding is K.E.Y.

   1. **Know the goal and its reason.** Before making changes, have a CLEAR understanding of what the goal is and why we are pursuing it. CLEAR means that the goal is unambiguous and that the reason for pursuing it is explicit.

   2. **Establish the HOW.** The HOW defines the path or plan for achieving the goal.

   3. **You clarify before changing.** If either the goal or the HOW is not CLEAR, ask questions until the ambiguity is resolved before making changes.

2. Code should be C.L.E.A.N.

   1. **Clarity and readability.** Code should be elegant, simple, and direct. Meaningful names, well-defined abstractions, and straightforward control flow should make its purpose and behavior clear enough for a developer other than its original author to read, maintain, and extend it.

   2. **Lean design and structure.** Code should represent the system’s design without unnecessary duplication or complexity, using only the classes, methods, functions, and other entities needed for clarity. Dependencies should be explicit and limited to the minimum required by the design. Exposed APIs should be clear, consistent, and no broader than necessary.

   3. **Explicit error handling.** Error handling should follow a complete and explicit strategy that covers expected failure modes.

   4. **Analysis before optimization.** Code should meet its defined performance requirements. Optimizations should be based on measurements rather than assumptions.

   5. **Necessary documentation.** When intent, constraints, or trade-offs cannot be expressed clearly through code alone, concise documentation should provide that context.

3. Changes should be appropriately tested, and unit tests should be F.I.R.S.T.

   1. **Fast:** Tests should run quickly.

   2. **Independent:** Tests should not depend on each other and should be runnable in any order.

   3. **Repeatable:** Tests should produce the same result in every correctly configured test environment and should not depend on nondeterministic external resources.

   4. **Self-Validating:** Tests should produce an objective, automated pass-or-fail result without requiring manual inspection. A change should not be considered complete until the required test suite passes.

   5. **Timely and Targeted:** Each change should be covered by appropriate automated tests. Tests should be written at the appropriate time, ideally immediately before or alongside the production code they validate.

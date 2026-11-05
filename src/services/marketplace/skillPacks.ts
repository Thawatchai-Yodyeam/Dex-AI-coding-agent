/**
 * คำสั่งของ skill ที่มากับ Marketplace — เขียนเป็นภาษาอังกฤษเพราะอ่านโดยโมเดล (ตอบผู้ใช้เป็นภาษาของผู้ใช้)
 * รูปแบบเดียวกับ SKILL.md ทั่วไป: ไม่มีโปรแกรมรัน มีแค่ข้อความคำสั่ง
 */

export const CODE_REVIEW_SKILL = `
Review the change the user points at. If they do not name one, review the uncommitted diff (\`git diff HEAD\`). If that is empty, review the last commit.

1. Read the diff, then read the surrounding code it touches. A diff alone hides most bugs.
2. Work out what the change is meant to do and check that it does it, including the paths the author may not have considered: empty input, errors, retries, concurrency, existing callers.
3. Report only problems you can defend. For each one give the file and line, what goes wrong, and a concrete input or sequence that triggers it. Put the worst first.
4. Leave out style preferences unless they hide a bug. If you find nothing, say so plainly and say what you checked.

Do not edit files during a review unless the user asks for fixes.
`;

export const COMMIT_MESSAGE_SKILL = `
Write a commit message for the staged changes. If nothing is staged, use the unstaged diff and say that you did.

1. Read \`git diff --staged\` and \`git log -5 --oneline\` so the message matches the project's style and language.
2. Subject: imperative mood, at most 72 characters, describing the effect rather than the files touched.
3. Body: add one only if it says something the diff cannot. Explain why the change exists and what it replaces.
4. If the diff holds unrelated changes, say so and propose how to split them.

Show the message. Commit only if the user asked you to.
`;

export const TEST_WRITER_SKILL = `
Add tests for the behaviour the user names, or for the code changed in the current diff.

1. Find how the project already tests this kind of code: runner, file layout, fixtures, mocking style. Follow it, and do not add a new framework.
2. List the behaviours worth pinning down: the normal case, boundaries, failure paths, and any bug this change fixes.
3. Assert on observable results rather than implementation details. A good test fails when the behaviour breaks and survives a refactor.
4. Run the tests. Confirm a new test can fail, either by breaking the code briefly or by reasoning it through, and say which you did.
5. Report what passes, what fails, and what stays untested. If a test exposes a real bug, report the bug instead of bending the test to pass.
`;

export const DEBUG_PLAYBOOK_SKILL = `
Find the root cause before changing code.

1. Reproduce it: get the exact command, input and error. If it will not reproduce, say so and gather more evidence rather than guessing.
2. Read the whole error and the code path it points to.
3. Test one hypothesis at a time. State what result would prove it wrong, then run the smallest check that tells you: a log line, a focused test, or \`git log\` and \`git bisect\` for a regression.
4. Fix the cause, not the symptom. If the fix is a workaround, label it as one.
5. Re-run the reproduction, then the nearby tests. Add a regression test when the project has tests.

Report the cause, the fix, and how you verified it. Remove temporary logging before finishing.
`;

export const EXPLAIN_CODE_SKILL = `
Explain code so the user understands it well enough to change it. Reply in the user's language.

1. Start with what the code is for and where it sits in the project, in two or three sentences.
2. Walk through the flow in execution order, not file order. Quote only the lines that matter, with the file and line number.
3. Explain the reason behind non-obvious choices. Name the concept when one applies, such as debounce or optimistic update, with a one-line definition.
4. Point out one or two places where a change would be easy to get wrong.
5. End with one question the user can use to check their own understanding.

Adjust the depth to the question. Do not edit files.
`;

export const DOCS_WRITER_SKILL = `
Write or update documentation from what the code does now.

1. Read the code, the existing docs and the project manifest before writing. Run the commands you document when it is safe to do so.
2. Lead with what the reader most needs: what it is, how to install it, and the shortest working example.
3. Match the existing tone and language. Prefer short sections and commands that can be copied and run.
4. Never document something you did not confirm in the code. Mark anything unverified clearly.
5. Update docs in place when they exist rather than adding a parallel file.

List what you changed and anything you could not verify.
`;

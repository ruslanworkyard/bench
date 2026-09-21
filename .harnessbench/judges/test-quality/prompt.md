<!-- Draft rubric shipped with harnessbench. Edit it to fit your codebase; this file is yours. -->
Criterion: the quality of the tests added or changed. Whether the tests exercise behaviour
through the public surface rather than restating the implementation; whether they would fail
if the feature were broken or removed; whether edge cases named or implied by the task are
covered; whether test names say what is being asserted; whether they follow the test
conventions visible in the diff's context. The test result (passed / failed) is a fact, not
the criterion: passing tests that test nothing lose to failing tests that test the right
thing, if the failure is in the code. A side that added no tests when the task called for
them loses on this criterion.

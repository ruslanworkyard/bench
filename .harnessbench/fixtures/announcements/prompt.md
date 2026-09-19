Add support for in-app announcements: short messages an operator publishes to all users for a
period of time (maintenance windows, new features, policy changes).

An announcement has a title, a body, a level (`info`, `warning`, `critical`), a publish time,
an optional expiry time, and a created-at timestamp. Store announcements in a new table using
this project's existing persistence approach (migrations, models or repositories, naming
conventions), whatever that is here.

Provide two operations, exposed the way this project exposes similar functionality:

- Create an announcement. Title and body are required; level defaults to `info`; publish time
  defaults to now; expiry, if given, must be after the publish time.
- List active announcements: published at or before now and not yet expired, ordered by level
  (`critical` first) and then by publish time, newest first.

Write tests in the project's existing style covering validation, defaulting, the active window
(not yet published, active, expired) and the ordering.

Do not add dependencies. Do not touch existing tables.

-- One open scheduler task per skill. The skill tick checks for an open task and
-- then inserts; this index is what makes that atomic when two ticks race.
create unique index if not exists tasks_skill_schedule_one_open_idx
  on tasks (title)
  where actor_id = 'skill-scheduler'
    and title like 'Run scheduled skill %'
    and status in ('queued', 'claimed', 'running', 'review');

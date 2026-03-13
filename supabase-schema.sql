-- Create campaigns table
create table if not exists campaigns (
  id serial primary key,
  name text not null,
  total_contacts integer default 0,
  total_calls integer default 0,
  connect_rate text default '0%',
  connect_count integer default 0,
  success_rate text default '0%',
  success_count integer default 0,
  status text check (status in ('Completed','Stopped','Active','Paused')) default 'Active',
  group_name text default 'General',
  is_duplicate boolean default false,
  created_at timestamptz default now()
);

-- Create contacts table
create table if not exists contacts (
  id serial primary key,
  campaign_id integer references campaigns(id) on delete cascade,
  name text not null,
  phone text not null,
  attempts integer default 0,
  last_attempt text default '-',
  call_duration text default '-',
  status text check (status in ('Unreached','Interested','Sent SMS','Declined Offer','Not interested','Do not call','Pending Retry')) default 'Unreached',
  created_at timestamptz default now()
);

-- Enable Row Level Security
alter table campaigns enable row level security;
alter table contacts enable row level security;

-- Allow all operations for anon (public access for now)
create policy "Allow all campaigns" on campaigns for all using (true) with check (true);
create policy "Allow all contacts" on contacts for all using (true) with check (true);

-- Seed campaigns
insert into campaigns (id, name, total_contacts, total_calls, connect_rate, connect_count, success_rate, success_count, status, group_name) values
(1, 'Lucky7even REACTIVATION offer to 300% deposit', 317, 2940, '11.36%', 36, '38.89%', 14, 'Completed', 'Reactivation'),
(2, 'Lucky7even RND Calls v2 German', 1028, 54, '0%', 0, '0%', 0, 'Stopped', 'RND'),
(3, 'Lucky7even RND Calls v2 Italian', 187, 531, '19.79%', 37, '18.92%', 7, 'Stopped', 'RND'),
(4, 'Lucky7even RND Calls v2 (Sign Up Date)', 432, 4300, '0.93%', 4, '0%', 0, 'Stopped', 'RND'),
(5, 'Lucky7even RND Calls v2 - Canada', 331, 2682, '27.19%', 90, '16.67%', 15, 'Stopped', 'Canada'),
(6, 'Lucky7even RND Calls v2 - Canada (1-15)', 373, 2852, '33.51%', 125, '28.00%', 35, 'Stopped', 'Canada'),
(7, 'Lucky7even RND Calls v2 - Canada (15-90)', 1294, 10112, '26.04%', 337, '31.45%', 106, 'Stopped', 'Canada'),
(8, 'Lucky7even RND Calls v2 - Canada (17-23)', 209, 1545, '27.27%', 57, '42.11%', 24, 'Stopped', 'Canada'),
(9, 'Lucky7even Legacy Promo - Q4', 512, 3210, '21.50%', 69, '14.49%', 10, 'Paused', 'Archived'),
(10, 'Lucky7even Welcome Bonus v1', 391, 1699, '15.24%', 26, '11.54%', 3, 'Paused', 'Archived');

-- Seed contacts
insert into contacts (campaign_id, name, phone, attempts, last_attempt, call_duration, status) values
(1, 'Francis Brown', '+1 709 325 5216', 11, 'Mar 2, 2026', '-', 'Unreached'),
(1, 'Maxime Laferriere', '+1 581 994 2074', 10, 'Mar 2, 2026', '-', 'Unreached'),
(1, 'Veronique Picard', '+1 819 269 2031', 10, 'Mar 2, 2026', '-', 'Unreached'),
(1, 'Manel Labiod', '+1 438 467 8112', 10, 'Mar 2, 2026', '-', 'Unreached'),
(1, 'Roman Kotliakov', '+1 604 404 8182', 6, 'Mar 2, 2026', '-', 'Unreached'),
(1, 'Jeffery Bonnell', '+1 506 555 1234', 10, 'Mar 2, 2026', '-', 'Unreached'),
(1, 'Sophie Tremblay', '+1 514 882 3301', 4, 'Mar 1, 2026', '2m 14s', 'Interested'),
(1, 'Michel Ouellet', '+1 418 774 9920', 3, 'Feb 28, 2026', '1m 05s', 'Sent SMS'),
(1, 'Lisa Nguyen', '+1 647 203 4411', 2, 'Feb 27, 2026', '0m 42s', 'Declined Offer'),
(1, 'Carlos Reyes', '+1 780 561 7743', 5, 'Mar 2, 2026', '-', 'Do not call'),
(2, 'Anna Schmidt', '+49 151 234 5678', 3, 'Mar 1, 2026', '-', 'Unreached'),
(2, 'Klaus Müller', '+49 170 987 6543', 1, 'Feb 25, 2026', '3m 10s', 'Interested'),
(2, 'Helga Bauer', '+49 160 112 2334', 2, 'Feb 26, 2026', '-', 'Pending Retry'),
(2, 'Dieter Wolf', '+49 176 445 6677', 4, 'Mar 2, 2026', '1m 22s', 'Sent SMS'),
(2, 'Erika Zimmermann', '+49 152 998 8771', 2, 'Feb 28, 2026', '-', 'Not interested'),
(3, 'Marco Rossi', '+39 347 123 4567', 5, 'Mar 2, 2026', '2m 50s', 'Interested'),
(3, 'Giulia Ferrari', '+39 333 876 5432', 3, 'Mar 1, 2026', '-', 'Unreached'),
(3, 'Luca Bianchi', '+39 348 654 3210', 7, 'Mar 2, 2026', '1m 38s', 'Declined Offer'),
(3, 'Sofia Conti', '+39 320 111 2233', 2, 'Feb 27, 2026', '-', 'Pending Retry'),
(3, 'Davide Marino', '+39 349 445 6671', 4, 'Mar 2, 2026', '0m 55s', 'Sent SMS'),
(4, 'James Carter', '+1 416 201 3344', 8, 'Mar 2, 2026', '-', 'Unreached'),
(4, 'Emily Thompson', '+1 905 342 5566', 3, 'Feb 28, 2026', '4m 02s', 'Interested'),
(4, 'Noah Williams', '+1 778 234 1122', 5, 'Mar 1, 2026', '-', 'Not interested'),
(4, 'Olivia Johnson', '+1 613 987 4433', 2, 'Feb 26, 2026', '1m 17s', 'Sent SMS'),
(4, 'Liam Brown', '+1 204 556 7788', 9, 'Mar 2, 2026', '-', 'Do not call');

-- Reset sequences so new inserts get correct IDs
select setval('campaigns_id_seq', (select max(id) from campaigns));
select setval('contacts_id_seq', (select max(id) from contacts));

-- Create knowledge_bases table
create table if not exists knowledge_bases (
  id           serial primary key,
  name         text not null,
  data_sources integer default 0,
  created_at   timestamptz default now(),
  archived     boolean default false
);

alter table knowledge_bases enable row level security;
create policy "Allow all knowledge_bases" on knowledge_bases for all using (true) with check (true);

insert into knowledge_bases (name, data_sources, created_at, archived) values
('Lucky 7 RND campaign',                 10, '2025-11-06', false),
('Lucky7even (FAQ / Objection Handling)',  0, '2025-11-11', false),
('Test',                                  0, '2026-02-04', false);

-- Create do_not_call table
create table if not exists do_not_call (
  id serial primary key,
  phone_number text not null unique,
  added_at timestamptz default now(),
  archived boolean default false
);

-- Enable Row Level Security
alter table do_not_call enable row level security;

-- Allow all operations for anon (public access for now)
create policy "Allow all do_not_call" on do_not_call for all using (true) with check (true);

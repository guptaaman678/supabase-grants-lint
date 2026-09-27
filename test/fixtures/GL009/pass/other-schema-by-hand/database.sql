create schema private;
create table private.jobs (id int);
grant all on private.jobs to anon;

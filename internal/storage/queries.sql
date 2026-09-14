-- name: Identity :one
SELECT protocol,public_key,private_key FROM identity WHERE singleton=1;
-- name: CreateIdentity :exec
INSERT INTO identity(singleton,protocol,public_key,private_key) VALUES(1,?,?,?);
-- name: Deployment :one
SELECT kind,unit,listen_address FROM deployment WHERE singleton=1;
-- name: CreateDeployment :exec
INSERT INTO deployment(singleton,kind,unit,listen_address) VALUES(1,?,?,?);
-- name: CreateSettings :exec
INSERT INTO settings(singleton) VALUES(1);
-- name: CreateController :exec
INSERT INTO controller(singleton,enabled,port,secret) VALUES(1,?,?,?);
-- name: Installed :one
SELECT installed FROM settings WHERE singleton=1;
-- name: SetInstalled :exec
UPDATE settings SET installed=1 WHERE singleton=1;
-- name: Settings :one
SELECT github_proxy,interfaces FROM settings WHERE singleton=1;
-- name: SaveSettings :exec
UPDATE settings SET github_proxy=?,interfaces=? WHERE singleton=1;
-- name: Controller :one
SELECT enabled,port,secret FROM controller WHERE singleton=1;
-- name: SaveController :exec
UPDATE controller SET enabled=?,port=?,secret=? WHERE singleton=1;
-- name: Configuration :one
SELECT id,url,enabled,port,secret,dashboard FROM configurations WHERE id=?;
-- name: SaveConfiguration :exec
INSERT INTO configurations(id,url,enabled,port,secret,dashboard) VALUES(?,?,?,?,?,?);
-- name: Pending :one
SELECT previous,next,was_running FROM pending WHERE singleton=1;
-- name: SavePending :exec
INSERT INTO pending(singleton,previous,next,was_running) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET previous=excluded.previous,next=excluded.next,was_running=excluded.was_running;
-- name: ClearPending :exec
DELETE FROM pending;
-- name: OldConfigurations :many
SELECT id FROM configurations WHERE id<>? ORDER BY seq DESC LIMIT -1 OFFSET 2;
-- name: DeleteConfiguration :exec
DELETE FROM configurations WHERE id=?;
-- name: SaveDashboard :exec
INSERT INTO dashboards(id,version) VALUES(?,?);
-- name: Dashboard :one
SELECT version FROM dashboards WHERE id=?;
-- name: CoreVersion :one
SELECT version FROM core_version WHERE singleton=1 AND identity=?;
-- name: SaveCoreVersion :exec
INSERT INTO core_version(singleton,identity,version) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET identity=excluded.identity,version=excluded.version;
-- name: Task :one
SELECT id,action,state,phase,updated,result,error,hash FROM tasks WHERE id=?;
-- name: LatestTask :one
SELECT latest_task FROM settings WHERE singleton=1 AND latest_task IS NOT NULL;
-- name: ClearLatest :exec
UPDATE settings SET latest_task=NULL WHERE singleton=1;
-- name: Fingerprint :one
SELECT fingerprint FROM tasks WHERE id=?;
-- name: Request :one
SELECT request FROM tasks WHERE id=?;
-- name: InterruptTasks :exec
UPDATE tasks SET state='interrupted',error=?,updated=?,request=NULL WHERE state IN ('queued','running');
-- name: InsertTask :exec
INSERT INTO tasks(id,action,state,phase,updated,result,error,hash,fingerprint,request) VALUES(?,?,?,?,?,?,?,?,?,?);
-- name: SetLatestTask :exec
UPDATE settings SET latest_task=? WHERE singleton=1;
-- name: UpdateTask :execrows
UPDATE tasks SET state=sqlc.arg(state),phase=sqlc.arg(phase),updated=sqlc.arg(updated),result=sqlc.arg(result),error=sqlc.arg(error),request=CASE sqlc.arg(state) WHEN 'queued' THEN request WHEN 'running' THEN request END WHERE id=sqlc.arg(id);
-- name: Updates :one
SELECT checked_at,self_current,self_latest,self_state,self_error,core_current,core_latest,core_state,core_error,dashboard_current,dashboard_latest,dashboard_state,dashboard_error FROM update_checks WHERE singleton=1;
-- name: SaveUpdates :exec
INSERT INTO update_checks(singleton,checked_at,self_current,self_latest,self_state,self_error,core_current,core_latest,core_state,core_error,dashboard_current,dashboard_latest,dashboard_state,dashboard_error) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET checked_at=excluded.checked_at,self_current=excluded.self_current,self_latest=excluded.self_latest,self_state=excluded.self_state,self_error=excluded.self_error,core_current=excluded.core_current,core_latest=excluded.core_latest,core_state=excluded.core_state,core_error=excluded.core_error,dashboard_current=excluded.dashboard_current,dashboard_latest=excluded.dashboard_latest,dashboard_state=excluded.dashboard_state,dashboard_error=excluded.dashboard_error;

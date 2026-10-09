import { describe, expect, test } from 'claude-code/testing'

import { classifyBash, isSafeRm, mcpSql } from '../hooks/classify'
import { analyze } from '../hooks/sql'

const ROOT = '/home/me/repo'
const kind = (line: string) => classifyBash(line, ROOT)?.kind ?? null

describe('classifyBash', () => {
  test('infra commands that change things are held, reads are not', () => {
    expect(kind('cd infra && terraform apply -auto-approve')).toBe('terraform')
    expect(kind('terraform -chdir=envs/prod destroy')).toBe('terraform')
    expect(kind('terraform plan -out tfplan')).toBeNull()
    expect(kind('pulumi up -s prod --yes')).toBe('pulumi')
    expect(kind('pulumi preview')).toBeNull()
    expect(kind('gcloud run deploy api --region asia-southeast2')).toBe('gcloud')
    expect(kind('gcloud compute instances delete vm-1 --zone a')).toBe('gcloud')
    expect(kind('gcloud sql instances patch main --tier db-custom-2-8192')).toBe('gcloud')
    expect(kind('gcloud sql instances list')).toBeNull()
    expect(kind('aws --profile prod ec2 terminate-instances --instance-ids i-1')).toBe('aws')
    expect(kind('aws s3 rm s3://bucket/logs --recursive')).toBe('aws')
    expect(kind('aws s3 rb s3://bucket')).toBe('aws')
    expect(kind('aws s3 rm s3://bucket/one.txt')).toBeNull()
    expect(kind('aws rds describe-db-instances')).toBeNull()
    expect(kind('kubectl -n prod delete pod api-0')).toBe('kubectl')
    expect(kind('kubectl apply -f k8s/')).toBe('kubectl')
    expect(kind('kubectl get pods -n prod')).toBeNull()
    expect(kind('docker system prune -af')).toBe('docker')
  })

  test('rm -rf is held outside /tmp and build folders', () => {
    expect(kind('rm -rf node_modules dist')).toBeNull()
    expect(kind('rm -rf /tmp/scratch')).toBeNull()
    expect(kind('cd web && rm -rf .next/cache')).toBeNull()
    expect(kind(`rm -rf ${ROOT}/packages/api/dist`)).toBeNull()
    expect(kind('rm -rf src')).toBe('rm')
    expect(kind('rm -rf ~/projects')).toBe('rm')
    expect(kind('rm -rf ../dist')).toBe('rm')
    expect(kind('rm -rf "$OUT"')).toBe('rm')
    expect(kind('cd / && rm -rf build')).toBe('rm')
    expect(kind('rm -r src')).toBeNull()
    expect(isSafeRm(['dist/*'], null, ROOT)).toBe(true)
    expect(isSafeRm(['*/dist'], null, ROOT)).toBe(false)
  })

  test('destructive SQL through the mysql/psql CLI', () => {
    expect(kind('mysql -h db -u app -e "DELETE FROM sessions WHERE expires_at < NOW()" app')).toBe('sql')
    expect(kind('psql "$DATABASE_URL" -c "SELECT count(*) FROM users"')).toBeNull()
    expect(kind("psql -d app <<'SQL'\nUPDATE users SET plan = 'free';\nSQL")).toBe('sql')
    expect(kind('echo "TRUNCATE events" | mysql app')).toBe('sql')
    expect(classifyBash('mysql app < migrate.sql', ROOT)?.file).toBe('migrate.sql')
  })

  test('text that only mentions a command is not held', () => {
    expect(kind('git commit -m "remove terraform apply step; rm -rf old docs"')).toBeNull()
    expect(kind('grep -r "kubectl delete" docs/')).toBeNull()
  })

  test('DB MCP tools are recognised by name', () => {
    expect(mcpSql('mcp__mcp_server_mysql__mysql_query', { sql: 'DELETE FROM t' })?.sql).toBe('DELETE FROM t')
    expect(mcpSql('mcp__postgres-auth__execute_sql', { sql: 'SELECT 1' })?.key).toBe('sql')
    expect(mcpSql('mcp__claude_ai_Gmail__send_message', { sql: 'x' })).toBeNull()
  })
})

describe('analyze', () => {
  test('reads the WHERE and how wide it is', () => {
    const [none] = analyze('DELETE FROM users')
    expect(none).toMatchObject({ verb: 'DELETE', table: 'users', scope: 'none', count: 'SELECT COUNT(*) AS n FROM users' })

    const [range] = analyze("UPDATE orders o SET status = 'void' WHERE o.created_at < '2024-01-01' LIMIT 100")
    expect(range).toMatchObject({ verb: 'UPDATE', table: 'orders', scope: 'range' })
    expect(range?.count).toBe("SELECT COUNT(*) AS n FROM orders o WHERE o.created_at < '2024-01-01'")
    expect(range?.note).toContain('LIMIT')

    const [eq] = analyze('UPDATE main_v2.word_entries SET status = 2 WHERE id = 10296')
    expect(eq).toMatchObject({ scope: 'equality', table: 'main_v2.word_entries' })

    expect(analyze("UPDATE t SET note = 'no WHERE here'")[0]?.scope).toBe('none')
    expect(analyze('DELETE FROM t WHERE 1=1')[0]?.scope).toBe('none')
    expect(analyze('UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)')[0]?.scope).toBe('none')
  })

  test('schema changes and reads', () => {
    expect(analyze('DROP TABLE IF EXISTS audit_log CASCADE')[0]).toMatchObject({ verb: 'DROP', table: 'audit_log', scope: 'schema' })
    expect(analyze('TRUNCATE TABLE events')[0]?.count).toBe('SELECT COUNT(*) AS n FROM events')
    expect(analyze('ALTER TABLE users DROP COLUMN legacy')[0]?.note).toContain('Drops')
    expect(analyze("SELECT * FROM t WHERE x = 'DELETE FROM y'; INSERT INTO t VALUES (1)")).toHaveLength(0)
    expect(analyze('DELETE FROM a WHERE id = 1; DELETE FROM b')).toHaveLength(2)
    expect(analyze('DELETE t1 FROM t1 JOIN t2 ON t1.id = t2.id')[0]?.count).toBeUndefined()
  })
})

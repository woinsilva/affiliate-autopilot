import type { PoolClient } from 'pg';
import { db } from './db.js';

export type LedgerRow = {
  id: string;
  status: 'reserved' | 'succeeded' | 'failed' | 'uncertain';
  external_id: string | null;
  response: Record<string, unknown> | null;
};

export async function reserveOperation(input: {
  brandId: string;
  type: string;
  key: string;
  request: unknown;
}): Promise<{ row: LedgerRow; acquired: boolean }> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<LedgerRow>(
      `INSERT INTO operation_ledger (brand_id, operation_type, idempotency_key, status, request)
       VALUES ($1,$2,$3,'reserved',$4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id,status,external_id,response`,
      [input.brandId, input.type, input.key, JSON.stringify(input.request)],
    );
    if (inserted.rows[0]) {
      await client.query('COMMIT');
      return { row: inserted.rows[0], acquired: true };
    }
    const existing = await client.query<LedgerRow>(
      'SELECT id,status,external_id,response FROM operation_ledger WHERE idempotency_key=$1 FOR UPDATE',
      [input.key],
    );
    if (existing.rows[0]?.status === 'failed') {
      const retried = await client.query<LedgerRow>(
        `UPDATE operation_ledger SET status='reserved',request=$2,error=NULL,response=NULL,external_id=NULL,updated_at=now()
         WHERE id=$1 RETURNING id,status,external_id,response`,
        [existing.rows[0].id, JSON.stringify(input.request)],
      );
      await client.query('COMMIT');
      return { row: retried.rows[0]!, acquired: true };
    }
    await client.query('COMMIT');
    if (!existing.rows[0]) throw new Error('Operation ledger conflict without row');
    return { row: existing.rows[0], acquired: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function completeOperation(id: string, externalId: string | null, response: unknown): Promise<void> {
  await db.query(
    `UPDATE operation_ledger SET status='succeeded', external_id=$2, response=$3, updated_at=now() WHERE id=$1`,
    [id, externalId, JSON.stringify(response)],
  );
}

export async function markOperation(id: string, status: 'failed' | 'uncertain', error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.query('UPDATE operation_ledger SET status=$2,error=$3,updated_at=now() WHERE id=$1', [id, status, message]);
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

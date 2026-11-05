import { useSyncExternalStore } from 'react';
import { mcpManager } from '../services/mcp/manager';

const subscribe = (cb: () => void) => mcpManager.subscribe(cb);
// statuses() สร้าง array ใหม่ทุกครั้ง — เก็บ snapshot ไว้ให้ useSyncExternalStore เทียบได้
let snapshot = mcpManager.statuses();
mcpManager.subscribe(() => {
  snapshot = mcpManager.statuses();
});
const getSnapshot = () => snapshot;

/** สถานะการเชื่อมต่อจริงของ MCP server ทุกตัว */
export function useMcpStatuses() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

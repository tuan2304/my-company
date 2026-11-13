import path from 'node:path';
import { loadTeams, summarizeTeams } from '../server/teams.mjs';
import { REPO } from './helpers.mjs';

/** Những người được thêm sau đội hình gốc (mỗi team thêm vài người). Chỉ để dựng đội hình gọn cho test hành vi một tầng. */
const ADDED = new Set(['Khang', 'Nam', 'Hiếu', 'Yến', 'Bảo', 'Oanh', 'Hùng', 'Thu', 'Tâm', 'Nhi', 'Hà', 'Tiên', 'Lộc', 'Quỳnh', 'Linh', 'Đạt', 'Tú', 'Khoa']);

/** Đội hình thật của repo, đầy đủ. */
export const fullTeams = () => summarizeTeams(loadTeams({ teamsDir: path.join(REPO, 'teams') }));

/**
 * Đội hình thật nhưng bỏ những người thêm sau: đủ để lấp một tầng, giữ tên quen thuộc (Cúc, Lan, Giang…).
 * Các test về cách đi bộ, đường đi, bàn ghế dùng bản này để không phụ thuộc vào việc team có bao nhiêu người.
 */
export const compactTeams = () => fullTeams().map((t) => ({ ...t, members: t.members.filter((m) => !ADDED.has(m.name)) }));

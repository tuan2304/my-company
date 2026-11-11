import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatterFile } from './frontmatter.mjs';

// Model người dùng đã quyết định không dùng.
const BLOCKED_MODELS = ['fable'];

const DEFAULT_LIMITS = {
  max_active_per_member: 1, // mỗi người làm 1 việc tại một thời điểm
  max_queue_per_member: 2, // hàng chờ tối đa 2 việc
  max_revisions: 2, // số lần Trưởng nhóm được trả bài lại
  max_subtasks: 6, // số việc con tối đa của một việc lớn
};
const DEFAULT_ROLE = {
  model: 'sonnet',
  effort: 'medium',
  tools: ['Read', 'Grep', 'Glob'],
  max_turns: 30,
  timeout_minutes: 20,
  skills: [],
  stack_skills: {},
};

function asList(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * Đọc các thư mục trong teams/. Mỗi team có team.md (thành viên, giới hạn) và
 * các file vai trò *.md (frontmatter: model, effort, tools, ...; nội dung: chỉ dẫn).
 * Thư mục local/teams/ (nếu có) ghi đè theo từng dự án.
 */
export function loadTeams({ teamsDir, localTeamsDir }) {
  const teams = [];
  for (const dir of [teamsDir, localTeamsDir]) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const team = readTeam(path.join(dir, entry.name), entry.name);
      if (!team) continue;
      const index = teams.findIndex((t) => t.id === team.id);
      if (index >= 0) teams[index] = team;
      else teams.push(team);
    }
  }
  return teams;
}

function readTeam(teamDir, id) {
  const teamFile = path.join(teamDir, 'team.md');
  if (!fs.existsSync(teamFile)) return null;
  const { data, body: teamBody } = readFrontmatterFile(teamFile);

  const roles = {};
  for (const file of fs.readdirSync(teamDir)) {
    if (!file.endsWith('.md') || file === 'team.md') continue;
    const roleId = file.slice(0, -3);
    const { data: meta, body } = readFrontmatterFile(path.join(teamDir, file));
    const model = String(meta.model ?? DEFAULT_ROLE.model);
    const reviewModel = String(meta.review_model ?? model);
    for (const name of [model, reviewModel]) {
      if (BLOCKED_MODELS.some((blocked) => name.toLowerCase().includes(blocked))) {
        throw new Error(`Vai trò "${roleId}" của team "${id}" khai model "${name}", nhưng model này đã bị cấm dùng. Hãy đổi sang opus, sonnet hoặc haiku.`);
      }
    }
    roles[roleId] = {
      id: roleId,
      title: String(meta.title ?? roleId),
      model,
      effort: String(meta.effort ?? DEFAULT_ROLE.effort),
      // Dành cho Trưởng nhóm: duyệt bài thường nhẹ hơn lập kế hoạch nên có thể dùng model thấp hơn.
      review_model: reviewModel,
      review_effort: String(meta.review_effort ?? meta.effort ?? DEFAULT_ROLE.effort),
      review_max_turns: Number(meta.review_max_turns ?? meta.max_turns ?? DEFAULT_ROLE.max_turns),
      tools: asList(meta.tools ?? DEFAULT_ROLE.tools),
      max_turns: Number(meta.max_turns ?? DEFAULT_ROLE.max_turns),
      timeout_minutes: Number(meta.timeout_minutes ?? DEFAULT_ROLE.timeout_minutes),
      skills: asList(meta.skills),
      stack_skills: meta.stack_skills && typeof meta.stack_skills === 'object' ? meta.stack_skills : {},
      // Ghi chú chỉ nạp khi hồ sơ dự án có công nghệ khớp: công ty dùng nó để đè lên lời khuyên của skill bên ngoài.
      stack_notes: meta.stack_notes && typeof meta.stack_notes === 'object' ? meta.stack_notes : {},
      body,
    };
  }

  const members = (Array.isArray(data.members) ? data.members : []).map((m) => {
    if (!m || typeof m.name !== 'string' || typeof m.role !== 'string') {
      throw new Error(`team.md của "${id}" có thành viên thiếu name hoặc role`);
    }
    if (!roles[m.role]) {
      throw new Error(`Thành viên "${m.name}" của team "${id}" dùng vai trò "${m.role}" nhưng không có file ${m.role}.md`);
    }
    return { name: m.name, role: m.role, strengths: asList(m.strengths) };
  });

  const lead = data.lead ? String(data.lead) : null;
  if (lead && !members.some((m) => m.name === lead)) {
    throw new Error(`Team "${id}" khai Trưởng nhóm "${lead}" nhưng người này không có trong danh sách thành viên (members).`);
  }

  return {
    id,
    name: String(data.name ?? id),
    lead,
    members,
    roles,
    limits: { ...DEFAULT_LIMITS, ...(data.limits ?? {}) },
    // Team chỉ ghi tài liệu/báo cáo: hồ sơ dự án không khai thư mục cho team thì nhân viên KHÔNG ghi được file nào
    // (thay vì "ghi được mọi nơi" như team viết code).
    requiresFolders: data.requires_folders === true,
    // Mô tả team (thân team.md): Giám đốc đọc để biết nên giao việc gì cho team này.
    description: teamBody.trim(),
  };
}

/** Tìm thành viên theo tên (không phân biệt hoa thường). */
export function findMember(teams, name) {
  const wanted = String(name).trim().toLowerCase();
  for (const team of teams) {
    const member = team.members.find((m) => m.name.toLowerCase() === wanted);
    if (member) return { team, member, role: team.roles[member.role], isLead: team.lead === member.name };
  }
  return null;
}

/** Nhân viên làm việc của một team (không gồm Trưởng nhóm). */
export function workersOf(team) {
  return team.members.filter((m) => m.name !== team.lead);
}

export function summarizeTeams(teams) {
  return teams.map((team) => ({
    id: team.id,
    name: team.name,
    lead: team.lead,
    description: team.description ?? '',
    limits: team.limits,
    requiresFolders: team.requiresFolders === true,
    members: team.members.map((m) => {
      const role = team.roles[m.role];
      return {
        name: m.name, role: m.role, title: role.title, model: role.model, effort: role.effort,
        strengths: m.strengths, isLead: team.lead === m.name,
      };
    }),
  }));
}

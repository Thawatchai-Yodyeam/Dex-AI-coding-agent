import React from 'react';
import {
  BookOpen,
  Box,
  Brain,
  Briefcase,
  Bug,
  BugPlay,
  Clock,
  Cloud,
  Database,
  FileText,
  FlaskConical,
  Flame,
  Gamepad2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Globe,
  GraduationCap,
  Leaf,
  Library,
  ListTree,
  MessageCircleQuestion,
  NotebookPen,
  PenTool,
  Radar,
  Search,
  SearchCheck,
  Server,
  Telescope,
  Theater,
  type LucideIcon,
} from 'lucide-react';
import type { MarketplacePlugin, PluginIconName } from '../services/marketplace/catalog';

const ICONS: Record<PluginIconName, LucideIcon> = {
  'book-open': BookOpen,
  library: Library,
  brain: Brain,
  'list-tree': ListTree,
  clock: Clock,
  'git-branch': GitBranch,
  'bug-play': BugPlay,
  theater: Theater,
  search: Search,
  telescope: Telescope,
  flame: Flame,
  globe: Globe,
  'git-pull-request': GitPullRequest,
  database: Database,
  radar: Radar,
  leaf: Leaf,
  'graduation-cap': GraduationCap,
  cloud: Cloud,
  server: Server,
  briefcase: Briefcase,
  'notebook-pen': NotebookPen,
  'pen-tool': PenTool,
  box: Box,
  gamepad: Gamepad2,
  'search-check': SearchCheck,
  'git-commit': GitCommitHorizontal,
  flask: FlaskConical,
  bug: Bug,
  'message-question': MessageCircleQuestion,
  'file-text': FileText,
};

/** กรอบไอคอน — ไม่มี color = สีกลางของธีม (ใช้กับรายการที่ผู้ใช้เพิ่มเอง) */
export const PluginTile: React.FC<{ color?: string; children: React.ReactNode }> = ({ color, children }) => (
  <span className="plugin-tile" style={color ? ({ '--plugin-hue': color } as React.CSSProperties) : undefined} aria-hidden="true">
    {children}
  </span>
);

export const PluginIcon: React.FC<{ plugin: MarketplacePlugin }> = ({ plugin }) => {
  const Icon = ICONS[plugin.icon];
  return (
    <PluginTile color={plugin.color}>
      <Icon size={22} />
    </PluginTile>
  );
};

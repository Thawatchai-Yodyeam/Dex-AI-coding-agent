import React, { useState, useEffect, useCallback } from 'react';
import { Folder, FolderOpen, FileText, FileCode, RefreshCw, ChevronRight, ChevronDown, AtSign } from 'lucide-react';
import { tauriBridge } from '../services/tauriBridge';
import type { FileItem } from '../types/agent';
import type { Translation } from '../utils/i18n';

interface FileExplorerProps {
  workspace: string;
  t: Translation;
  onInsertPrompt?: (text: string) => void;
}

interface TreeNode {
  item: FileItem;
  isOpen?: boolean;
  isLoading?: boolean;
  children?: TreeNode[];
}

const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'rs', 'json', 'css', 'html', 'py', 'md', 'toml']);

function updateNode(nodes: TreeNode[], path: string, patch: Partial<TreeNode>): TreeNode[] {
  return nodes.map((n) => {
    if (n.item.path === path) return { ...n, ...patch };
    if (n.children) return { ...n, children: updateNode(n.children, path, patch) };
    return n;
  });
}

export const FileExplorer: React.FC<FileExplorerProps> = ({ workspace, t, onInsertPrompt }) => {
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);

  const loadDirectory = useCallback(
    async (dirPath: string): Promise<TreeNode[]> => {
      try {
        const items = await tauriBridge.listDir(dirPath || workspace, workspace);
        return items.map((item) => ({ item, children: item.is_dir ? [] : undefined }));
      } catch (err) {
        console.error('Failed to load directory:', dirPath, err);
        return [];
      }
    },
    [workspace]
  );

  const refreshRoot = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setRootNodes(await loadDirectory(''));
    setLoading(false);
  }, [loadDirectory, workspace]);

  useEffect(() => {
    refreshRoot();
  }, [refreshRoot]);

  const toggleFolder = async (node: TreeNode) => {
    if (node.isOpen) {
      setRootNodes((prev) => updateNode(prev, node.item.path, { isOpen: false }));
      return;
    }
    setRootNodes((prev) => updateNode(prev, node.item.path, { isLoading: true }));
    const children = await loadDirectory(node.item.path);
    setRootNodes((prev) => updateNode(prev, node.item.path, { isOpen: true, isLoading: false, children }));
  };

  const relativePath = (fullPath: string) => {
    const ws = workspace.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const p = fullPath.replace(/\\/g, '/');
    return p.toLowerCase().startsWith(`${ws}/`) ? p.slice(ws.length + 1) : p;
  };

  const renderTree = (nodes: TreeNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => {
      const isDir = node.item.is_dir;
      const ext = node.item.name.split('.').pop()?.toLowerCase() ?? '';
      return (
        <li key={node.item.path}>
          <div className="tree-row" style={{ paddingLeft: depth * 14 + 6 }}>
            <button
              type="button"
              className="tree-item"
              aria-expanded={isDir ? !!node.isOpen : undefined}
              onClick={() => (isDir ? toggleFolder(node) : onInsertPrompt?.(t.mentionFilePrompt(relativePath(node.item.path))))}
              title={node.item.path}
            >
              {isDir ? (
                node.isOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />
              ) : (
                <span className="tree-spacer" />
              )}
              {isDir ? (
                node.isOpen ? <FolderOpen size={15} aria-hidden="true" /> : <Folder size={15} aria-hidden="true" />
              ) : CODE_EXTENSIONS.has(ext) ? (
                <FileCode size={15} aria-hidden="true" />
              ) : (
                <FileText size={15} aria-hidden="true" />
              )}
              <span className="tree-name">{node.item.name}</span>
            </button>
            {!isDir && onInsertPrompt && (
              <button
                type="button"
                className="icon-btn icon-btn-sm tree-mention"
                onClick={() => onInsertPrompt(t.mentionFilePrompt(relativePath(node.item.path)))}
                aria-label={`${t.mentionFile}: ${node.item.name}`}
                title={t.mentionFile}
              >
                <AtSign size={13} aria-hidden="true" />
              </button>
            )}
          </div>
          {isDir && node.isOpen && node.children && (
            node.children.length === 0 ? (
              <div className="tree-empty" style={{ paddingLeft: (depth + 1) * 14 + 26 }}>
                {t.emptyFolder}
              </div>
            ) : (
              <ul className="tree-list">{renderTree(node.children, depth + 1)}</ul>
            )
          )}
        </li>
      );
    });

  return (
    <div className="file-explorer">
      <div className="sidebar-section-title file-explorer-head">
        <span className="file-explorer-ws" title={workspace}>
          {workspace ? workspace.replace(/\\/g, '/').split('/').filter(Boolean).pop() : t.noWorkspace}
        </span>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          onClick={refreshRoot}
          disabled={loading || !workspace}
          aria-label={t.refreshFiles}
          title={t.refreshFiles}
        >
          <RefreshCw size={13} className={loading ? 'spin' : ''} aria-hidden="true" />
        </button>
      </div>
      <div className="sidebar-scroll">
        {loading && rootNodes.length === 0 ? (
          <p className="sidebar-empty">{t.loadingFiles}</p>
        ) : rootNodes.length === 0 ? (
          <p className="sidebar-empty">{workspace ? t.emptyFolder : t.noWorkspace}</p>
        ) : (
          <ul className="tree-list">{renderTree(rootNodes)}</ul>
        )}
      </div>
    </div>
  );
};

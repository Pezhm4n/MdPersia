import React, { useEffect } from 'react';
import { QueueItem, LogEntry } from '../types';
import { PreviewTab } from './Workspace/PreviewTab';
import { TerminalTab } from './Workspace/TerminalTab';
import { Eye, Terminal } from 'lucide-react';

interface WorkspacePanelProps {
  selectedItem: QueueItem | null;
  markdownContent?: string;
  logs: LogEntry[];
  isRunning: boolean;
  theme?: 'dark' | 'light';
  activeTab: 'preview' | 'terminal';
  onTabChange: (tab: 'preview' | 'terminal') => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  previewNonce: number;
  onRefreshPreview: () => void;
  onClearLogs: () => void;
  onOpenInEditor?: (path: string) => void;
  onOpenOutputDir?: () => void;
}

export const WorkspacePanel: React.FC<WorkspacePanelProps> = ({
  selectedItem,
  markdownContent,
  logs,
  isRunning,
  theme = 'dark',
  activeTab,
  onTabChange,
  zoom,
  onZoomChange,
  previewNonce,
  onRefreshPreview,
  onClearLogs,
  onOpenInEditor,
  onOpenOutputDir,
}) => {
  // Surface live process output while a batch runs, then hand control back.
  useEffect(() => {
    if (isRunning) onTabChange('terminal');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  const tabClass = (active: boolean) =>
    `btn relative shrink-0 px-4 py-3 text-xs font-medium transition-colors duration-150 ${
      active ? 'text-blue-600 dark:text-blue-400' : 'text-muted hover:text-main'
    }`;

  return (
    <div className="flex flex-col h-full bg-card transition-colors duration-200">
      <div className="flex items-stretch justify-between gap-2 px-3 border-b border-main bg-surface transition-colors">
        <div className="flex min-w-0 overflow-x-auto" role="tablist" aria-label="نمای کاری">
          <button
            role="tab"
            aria-selected={activeTab === 'preview'}
            onClick={() => onTabChange('preview')}
            className={tabClass(activeTab === 'preview')}
          >
            <Eye className="w-4 h-4" />
            <span>پیش‌نمایش سند</span>
            {activeTab === 'preview' && (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-blue-500" />
            )}
          </button>

          <button
            role="tab"
            aria-selected={activeTab === 'terminal'}
            onClick={() => onTabChange('terminal')}
            className={tabClass(activeTab === 'terminal')}
          >
            <Terminal className="w-4 h-4" />
            <span>کنسول و گزارش‌ها</span>
            {isRunning && (
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse shrink-0" />
            )}
            {activeTab === 'terminal' && (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-blue-500" />
            )}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {activeTab === 'terminal' ? (
          <TerminalTab logs={logs} onClearLogs={onClearLogs} onOpenOutputDir={onOpenOutputDir} />
        ) : (
          <PreviewTab
            selectedItem={selectedItem}
            markdownContent={markdownContent}
            theme={theme}
            zoom={zoom}
            onZoomChange={onZoomChange}
            previewNonce={previewNonce}
            onRefresh={onRefreshPreview}
            onOpenInEditor={onOpenInEditor}
          />
        )}
      </div>
    </div>
  );
};

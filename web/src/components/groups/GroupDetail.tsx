import { GroupInfo } from '../../stores/groups';

interface GroupDetailProps {
  group: GroupInfo & { jid: string };
}

export function GroupDetail({ group }: GroupDetailProps) {
  const formatDate = (timestamp: string | number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="p-4 bg-slate-50 space-y-3">
      {/* JID */}
      <div>
        <div className="text-xs text-slate-500 mb-1">完整 JID</div>
        <code className="block text-xs font-mono bg-white px-3 py-2 rounded border border-slate-200 break-all">
          {group.jid}
        </code>
      </div>

      {/* Folder */}
      <div>
        <div className="text-xs text-slate-500 mb-1">文件夹</div>
        <div className="text-sm text-slate-900 font-medium">{group.folder}</div>
      </div>

      {/* Added At */}
      <div>
        <div className="text-xs text-slate-500 mb-1">添加时间</div>
        <div className="text-sm text-slate-900">
          {formatDate(group.added_at)}
        </div>
      </div>

      {/* Last Message */}
      {group.lastMessage && (
        <div>
          <div className="text-xs text-slate-500 mb-1">最后消息</div>
          <div className="text-sm text-slate-700 bg-white px-3 py-2 rounded border border-slate-200 line-clamp-3 break-words">
            {group.lastMessage}
          </div>
          {group.lastMessageTime && (
            <div className="text-xs text-slate-400 mt-1">
              {formatDate(group.lastMessageTime)}
            </div>
          )}
        </div>
      )}

      {/* Note */}
      <div className="text-xs text-slate-400 pt-2 border-t border-slate-200">
        暂不支持编辑群组配置
      </div>
    </div>
  );
}

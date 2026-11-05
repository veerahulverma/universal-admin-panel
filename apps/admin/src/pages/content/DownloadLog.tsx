import { useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api, type Page } from '../../lib/api';
import { DataTable, EmptyState, ErrorState, Pagination, When, type Column } from '../../components/ui';
import { fileSize } from './shared';

interface DownloadRow {
  id: string;
  file_id: string;
  file_title: string;
  resource_id: string | null;
  resource_title: string | null;
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  ip: string | null;
  user_agent: string | null;
  bytes: number;
  created_at: string;
}

/** Completed downloads, newest first; optionally for one file or one customer. */
export function DownloadLog({ fileId, userId, pageSize = 25 }: { fileId?: string; userId?: string; pageSize?: number }) {
  const [page, setPage] = useState(1);
  const downloads = useQuery({
    queryKey: ['access-downloads', fileId, userId, page, pageSize],
    queryFn: ({ signal }) => api.get<Page<DownloadRow>>('/api/admin/access/downloads', { fileId, userId, page, pageSize }, signal),
    placeholderData: keepPreviousData,
  });
  const columns: Column<DownloadRow>[] = [
    { key: 'when', header: 'When', cell: (d) => <When value={d.created_at} /> },
    {
      key: 'user',
      header: 'Customer',
      cell: (d) => (
        <Link to={`/customers/users/${d.user_id}`} className="block max-w-64 truncate hover:underline">
          {d.user_name || d.user_email || d.user_id}
        </Link>
      ),
    },
    ...(fileId
      ? []
      : [
          {
            key: 'file',
            header: 'File',
            cell: (d: DownloadRow) => (
              <Link to={`/content/files/${d.file_id}`} className="block max-w-64 truncate hover:underline">
                {d.file_title}
              </Link>
            ),
          },
        ]),
    { key: 'resource', header: 'Through', priority: 'low', cell: (d) => d.resource_title ?? '—' },
    { key: 'size', header: 'Size', align: 'right', priority: 'low', cell: (d) => <span className="tabular">{fileSize(d.bytes)}</span> },
    { key: 'ip', header: 'IP address', cell: (d) => <span className="font-mono text-xs">{d.ip ?? '—'}</span> },
  ];
  if (downloads.error) return <ErrorState error={downloads.error} onRetry={() => void downloads.refetch()} />;
  return (
    <>
      <DataTable
        caption="Download log"
        columns={columns}
        rows={downloads.data?.data}
        rowKey={(d) => d.id}
        loading={downloads.isLoading}
        fetching={downloads.isFetching && !downloads.isLoading}
        empty={<EmptyState icon={<Download />} title="No downloads yet" description="Downloads through signed links appear here." />}
      />
      {downloads.data && <Pagination page={downloads.data.page} pageSize={downloads.data.pageSize} total={downloads.data.total} onPage={setPage} />}
    </>
  );
}

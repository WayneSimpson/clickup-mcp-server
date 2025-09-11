/**
 * Tool Catalog for OpenAI Retrieval Fallback
 *
 * Exposes MCP tool definitions as pseudo-documents so ChatGPT retrievable
 * connectors can index and discover capabilities even when upstream data
 * queries return no results (e.g., ClickUp API auth issues).
 */

export type ToolCatalogEntry = {
  id: string;        // e.g. tool:get_workspace_hierarchy
  name: string;      // MCP tool name
  title: string;     // Human-readable title
  description: string;
  url: string;       // Reference doc URL
};

const repoUrl = 'https://github.com/TaazKareem/clickup-mcp-server';

export const toolCatalog: ToolCatalogEntry[] = [
  { id: 'tool:search', name: 'search', title: 'Search', description: 'Universal retrieval: search by keywords and return top-k IDs.', url: repoUrl },
  { id: 'tool:fetch', name: 'fetch', title: 'Fetch', description: 'Universal retrieval: fetch a single document by ID and return id, title, text, url, metadata.', url: repoUrl },
  { id: 'tool:get_workspace_hierarchy', name: 'get_workspace_hierarchy', title: 'Get Workspace Hierarchy', description: 'Gets complete workspace hierarchy (spaces, folders, lists).', url: repoUrl },
  // Task tools
  { id: 'tool:create_task', name: 'create_task', title: 'Create Task', description: 'Creates a ClickUp task in a list.', url: repoUrl },
  { id: 'tool:update_task', name: 'update_task', title: 'Update Task', description: 'Updates an existing ClickUp task.', url: repoUrl },
  { id: 'tool:move_task', name: 'move_task', title: 'Move Task', description: 'Moves a ClickUp task to another list.', url: repoUrl },
  { id: 'tool:duplicate_task', name: 'duplicate_task', title: 'Duplicate Task', description: 'Duplicates a ClickUp task.', url: repoUrl },
  { id: 'tool:get_task', name: 'get_task', title: 'Get Task', description: 'Retrieves a ClickUp task by ID.', url: repoUrl },
  { id: 'tool:delete_task', name: 'delete_task', title: 'Delete Task', description: 'Deletes a ClickUp task by ID.', url: repoUrl },
  { id: 'tool:get_task_comments', name: 'get_task_comments', title: 'Get Task Comments', description: 'Gets comments for a ClickUp task.', url: repoUrl },
  { id: 'tool:create_task_comment', name: 'create_task_comment', title: 'Create Task Comment', description: 'Creates a new comment on a ClickUp task.', url: repoUrl },
  { id: 'tool:attach_task_file', name: 'attach_task_file', title: 'Attach Task File', description: 'Attaches a file to a ClickUp task.', url: repoUrl },
  { id: 'tool:get_workspace_tasks', name: 'get_workspace_tasks', title: 'Get Workspace Tasks', description: 'Retrieves tasks across the workspace with filters.', url: repoUrl },
  { id: 'tool:get_task_time_entries', name: 'get_task_time_entries', title: 'Get Task Time Entries', description: 'Gets time entries for a task.', url: repoUrl },
  { id: 'tool:start_time_tracking', name: 'start_time_tracking', title: 'Start Time Tracking', description: 'Starts time tracking for a task.', url: repoUrl },
  { id: 'tool:stop_time_tracking', name: 'stop_time_tracking', title: 'Stop Time Tracking', description: 'Stops time tracking for a task.', url: repoUrl },
  { id: 'tool:add_time_entry', name: 'add_time_entry', title: 'Add Time Entry', description: 'Adds a manual time entry to a task.', url: repoUrl },
  { id: 'tool:delete_time_entry', name: 'delete_time_entry', title: 'Delete Time Entry', description: 'Deletes a time entry from a task.', url: repoUrl },
  { id: 'tool:get_current_time_entry', name: 'get_current_time_entry', title: 'Get Current Time Entry', description: 'Gets currently running time entry.', url: repoUrl },
  // List tools
  { id: 'tool:create_list', name: 'create_list', title: 'Create List', description: 'Creates a list within a folder or space.', url: repoUrl },
  { id: 'tool:create_list_in_folder', name: 'create_list_in_folder', title: 'Create List in Folder', description: 'Creates a list within a folder.', url: repoUrl },
  { id: 'tool:get_list', name: 'get_list', title: 'Get List', description: 'Retrieves a list by ID.', url: repoUrl },
  { id: 'tool:update_list', name: 'update_list', title: 'Update List', description: 'Updates a list.', url: repoUrl },
  { id: 'tool:delete_list', name: 'delete_list', title: 'Delete List', description: 'Deletes a list.', url: repoUrl },
  // Folder tools
  { id: 'tool:create_folder', name: 'create_folder', title: 'Create Folder', description: 'Creates a folder within a space.', url: repoUrl },
  { id: 'tool:get_folder', name: 'get_folder', title: 'Get Folder', description: 'Retrieves a folder by ID.', url: repoUrl },
  { id: 'tool:update_folder', name: 'update_folder', title: 'Update Folder', description: 'Updates a folder.', url: repoUrl },
  { id: 'tool:delete_folder', name: 'delete_folder', title: 'Delete Folder', description: 'Deletes a folder.', url: repoUrl },
  // Tag tools
  { id: 'tool:get_space_tags', name: 'get_space_tags', title: 'Get Space Tags', description: 'Lists all tags in a space.', url: repoUrl },
  { id: 'tool:add_tag_to_task', name: 'add_tag_to_task', title: 'Add Tag to Task', description: 'Adds a tag to a task.', url: repoUrl },
  { id: 'tool:remove_tag_from_task', name: 'remove_tag_from_task', title: 'Remove Tag from Task', description: 'Removes a tag from a task.', url: repoUrl },
  // Member tools
  { id: 'tool:get_workspace_members', name: 'get_workspace_members', title: 'Get Workspace Members', description: 'Returns all members in the workspace.', url: repoUrl },
  { id: 'tool:find_member_by_name', name: 'find_member_by_name', title: 'Find Member by Name', description: 'Finds a member by name or email.', url: repoUrl },
  { id: 'tool:resolve_assignees', name: 'resolve_assignees', title: 'Resolve Assignees', description: 'Resolves names/emails to user IDs.', url: repoUrl },
  // Documents
  { id: 'tool:create_document', name: 'create_document', title: 'Create Document', description: 'Creates a document in a space, folder, or list.', url: repoUrl },
  { id: 'tool:get_document', name: 'get_document', title: 'Get Document', description: 'Gets details of a ClickUp document.', url: repoUrl },
  { id: 'tool:list_documents', name: 'list_documents', title: 'List Documents', description: 'Lists documents under a parent container.', url: repoUrl },
  { id: 'tool:list_document_pages', name: 'list_document_pages', title: 'List Document Pages', description: 'Lists pages in a document.', url: repoUrl },
  { id: 'tool:get_document_pages', name: 'get_document_pages', title: 'Get Document Pages', description: 'Gets content of specific document pages.', url: repoUrl },
  { id: 'tool:create_document_page', name: 'create_document_page', title: 'Create Document Page', description: 'Creates a new page in a document.', url: repoUrl },
  { id: 'tool:update_document_page', name: 'update_document_page', title: 'Update Document Page', description: 'Updates a document page.', url: repoUrl },
];

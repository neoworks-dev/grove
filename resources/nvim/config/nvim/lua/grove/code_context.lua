-- Push the named code scopes enclosing the cursor (function/class/etc, outer
-- first) to grove's breadcrumb bar. Treesitter-based, so it works in any
-- buffer with a running parser; buffers without one report an empty chain.
local function grove_code_context()
  local ok, node = pcall(vim.treesitter.get_node)
  if not ok then
    return {}
  end
  local names = {}
  while node do
    local node_type = node:type()
    local is_scope = node_type:find("function")
      or node_type:find("method")
      or node_type:find("class")
      or node_type:find("interface")
      or node_type:find("struct")
      or node_type:find("enum")
      or node_type:find("module")
      or node_type:find("namespace")
      or node_type:find("impl")
    if is_scope then
      local name_node = node:field("name")[1]
      if name_node then
        table.insert(names, 1, vim.treesitter.get_node_text(name_node, 0))
      end
    elseif node_type == "variable_declarator" then
      -- `const foo = () => …`: the arrow function itself is anonymous, its
      -- name lives on the declarator.
      local value = node:field("value")[1]
      local name_node = node:field("name")[1]
      if value and name_node and value:type():find("function") then
        table.insert(names, 1, vim.treesitter.get_node_text(name_node, 0))
      end
    end
    node = node:parent()
  end
  return names
end

local code_context_timer = nil
vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI", "BufEnter" }, {
  callback = function()
    if code_context_timer then
      code_context_timer:stop()
    end
    code_context_timer = vim.defer_fn(function()
      vim.rpcnotify(0, "grove_code_context", { names = grove_code_context() })
    end, 120)
  end,
})

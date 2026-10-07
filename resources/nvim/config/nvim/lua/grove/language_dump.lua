-- Writes the language servers this profile enables, and the filetype nvim gives
-- each file extension, as JSON to the file GROVE_LSP_DUMP names, then quits.
-- Grove's agent tools (src/main/editorLanguages.ts) start the servers the
-- editor would from this, so a server that works in the editor works for an
-- agent too, without Grove keeping a list of its own.

--- The argv a server's command would run. A command given as a function
--- (lspconfig's svelte, for one) is called with vim.lsp.rpc.start stubbed out,
--- which is where such functions hand their argv; nothing is started. One that
--- connects over a socket or does anything else is left out.
local function languageServerCommand(config)
  if type(config.cmd) == "table" then
    return config.cmd
  end
  if type(config.cmd) ~= "function" then
    return nil
  end
  local start = vim.lsp.rpc.start
  local captured = nil
  vim.lsp.rpc.start = function(argv)
    captured = argv
    error("grove: command captured")
  end
  -- There is no buffer to find a root for here, and the config's root_dir may
  -- be the function that would find one, which these commands read as a path.
  local rootless = vim.tbl_extend("force", {}, config)
  rootless.root_dir = nil
  pcall(config.cmd, {}, rootless)
  vim.lsp.rpc.start = start
  if type(captured) ~= "table" then
    return nil
  end
  return captured
end

--- The enabled servers that can be started from outside nvim.
local function enabledLanguageServers()
  pcall(function()
    require("lazy").load({ plugins = { "mason-lspconfig.nvim" } })
  end)
  local servers = {}
  for _, config in ipairs(vim.lsp.get_configs({ enabled = true })) do
    local cmd = languageServerCommand(config)
    if cmd ~= nil and type(config.filetypes) == "table" then
      table.insert(servers, { name = config.name, cmd = cmd, filetypes = config.filetypes })
    end
  end
  return servers
end

--- The filetype nvim gives each extension it knows. One decided by a function
--- (`.ts` could be TypeScript or a Qt translation) is asked of vim.filetype.match
--- with a bare file name, which settles it the way a new file would be.
local function filetypesByExtension()
  local extensions = {}
  for extension, filetype in pairs(vim.filetype.inspect().extension) do
    if type(filetype) == "string" then
      extensions[extension] = filetype
    else
      local ok, matched = pcall(vim.filetype.match, { filename = "file." .. extension })
      if ok and type(matched) == "string" then
        extensions[extension] = matched
      end
    end
  end
  return extensions
end

if vim.env.GROVE_LSP_DUMP ~= nil and vim.env.GROVE_LSP_DUMP ~= "" then
  vim.api.nvim_create_autocmd("VimEnter", {
    once = true,
    callback = function()
      vim.schedule(function()
        local ok, err = pcall(function()
          local dump = { servers = enabledLanguageServers(), extensions = filetypesByExtension() }
          vim.fn.writefile({ vim.json.encode(dump) }, vim.env.GROVE_LSP_DUMP)
        end)
        if ok then
          vim.cmd("qall!")
        else
          io.stderr:write(tostring(err) .. "\n")
          vim.cmd("cquit! 1")
        end
      end)
    end,
  })
end

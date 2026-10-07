-- Nvim's built-in LSP defaults deliberately leave `gd` as Vim's same-file
-- declaration search and put references on `grr`. Grove's goto layer uses the
-- conventional `gd`/`gD`/`gr` keys instead: imports follow their server target
-- and references do not appear to stall waiting for a third key. References
-- are presented by Grove rather than quickfix, so they share the searchable
-- preview overlay used by ripgrep. Remove the longer global mapping so it cannot
-- compete with the buffer-local `gr`.
pcall(vim.keymap.del, "n", "grr")

-- Jumps to the one location a goto request found, as nvim does itself: the
-- origin goes on the jumplist and the tag stack, so <C-o> and <C-t> return.
local function grove_jump_to_location(item, origin)
  local target = item.bufnr or vim.fn.bufadd(item.filename)
  vim.cmd("normal! m'")
  vim.fn.settagstack(vim.fn.win_getid(origin.win), {
    items = { { tagname = origin.tagname, from = origin.from } },
  }, "t")
  vim.bo[target].buflisted = true
  vim.api.nvim_win_set_buf(origin.win, target)
  vim.api.nvim_win_set_cursor(origin.win, { item.lnum, item.col - 1 })
  vim._with({ win = origin.win }, function()
    vim.cmd("normal! zv")
  end)
end

-- A quickfix item as grove's location picker takes it. Quickfix columns are
-- bytes, which is what the utf-8 offset encoding means, so the picker's jump
-- lands exactly where nvim's own would.
local function grove_location_from_item(item)
  return {
    path = item.filename,
    uri = vim.uri_from_fname(item.filename),
    line = item.lnum - 1,
    col = item.col - 1,
    endLine = (item.end_lnum or item.lnum) - 1,
    endCol = (item.end_col or item.col) - 1,
    encoding = "utf-8",
  }
end

-- Goto requests with several answers (merged interfaces, overloads, a symbol
-- two servers both know) open grove's location picker, the one references use,
-- rather than a quickfix split. One answer still jumps straight there. Wraps
-- the functions themselves so nvim's right-click menu and plugins get it too;
-- a caller with its own on_list or a loclist keeps nvim's behaviour.
local function grove_goto(original, label)
  return function(opts)
    opts = opts or {}
    if opts.on_list ~= nil or opts.loclist then
      return original(opts)
    end
    local origin = {
      win = vim.api.nvim_get_current_win(),
      tagname = vim.fn.expand("<cword>"),
      from = vim.fn.getpos("."),
    }
    origin.from[1] = vim.api.nvim_get_current_buf()
    return original(vim.tbl_extend("force", opts, {
      on_list = function(list)
        if #list.items == 1 then
          grove_jump_to_location(list.items[1], origin)
          return
        end
        vim.rpcnotify(0, "grove_locations", {
          label = label,
          symbol = origin.tagname,
          locations = vim.tbl_map(grove_location_from_item, list.items),
        })
      end,
    }))
  end
end
vim.lsp.buf.definition = grove_goto(vim.lsp.buf.definition, "Definitions")
vim.lsp.buf.declaration = grove_goto(vim.lsp.buf.declaration, "Declarations")
vim.lsp.buf.type_definition = grove_goto(vim.lsp.buf.type_definition, "Type definitions")
vim.lsp.buf.implementation = grove_goto(vim.lsp.buf.implementation, "Implementations")
vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(args)
    vim.keymap.set("n", "gd", vim.lsp.buf.definition, {
      buffer = args.buf,
      desc = "Go to definition",
    })
    vim.keymap.set("n", "gD", vim.lsp.buf.declaration, {
      buffer = args.buf,
      desc = "Go to declaration",
    })
    vim.keymap.set("n", "gr", function()
      vim.rpcnotify(0, "grove_references", { symbol = vim.fn.expand("<cword>") })
    end, {
      buffer = args.buf,
      desc = "Go to references",
      -- Built-in LSP maps such as `grt` share this prefix. Grove deliberately
      -- owns exact `gr`, so do not wait for a third key before opening its picker.
      nowait = true,
    })

    local client = vim.lsp.get_client_by_id(args.data.client_id)
    if client and client:supports_method("textDocument/inlayHint") then
      pcall(vim.lsp.inlay_hint.enable, true, { bufnr = args.buf })
    end
  end,
})

// WhatsApp Web only — keeps the chat list where the child expects it.
// This lives in its own content script (matched to web.whatsapp.com only)
// because the previous version ran a MutationObserver over document.body on
// every website in the world.

const observer = new MutationObserver(layoutChatList);

function startObserver() {
  if (!document.body) return;
  observer.observe(document.body, { childList: true, subtree: true });
}

function layoutChatList() {
  const sidebar = document.querySelector(".sidebar-slider-item");
  const sidebarContent = document.querySelector(".sidebar-content");
  const chatListContainer = document.querySelector("#chatlist-container");
  const chatListPart = document.querySelector(".chatlist-parts");
  const chatList = document.querySelector(".chatlist-top");
  const chatListHeader = document.querySelectorAll("[data-testid=chatlist-header]");
  const searchbar = document.querySelector("[data-testid=chat-list-search-container]");
  const tablist = document.querySelector("[role=tablist]");

  if (tablist) tablist.remove();
  if (searchbar) searchbar.remove();
  chatListHeader.forEach((element) => element.remove());

  if (!chatList || !sidebar || !sidebarContent || !chatListPart || !chatListContainer) {
    return;
  }

  if (
    chatListPart.firstElementChild === chatList &&
    sidebarContent.firstElementChild === chatListContainer &&
    sidebar.firstElementChild === sidebarContent
  ) {
    return;
  }

  observer.disconnect();
  chatListPart.replaceChildren(chatList);
  sidebarContent.replaceChildren(chatListContainer);
  sidebar.replaceChildren(sidebarContent);
  startObserver();
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      layoutChatList();
      startObserver();
    },
    { once: true },
  );
} else {
  layoutChatList();
  startObserver();
}

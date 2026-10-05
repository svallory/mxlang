; MX outline. Base taken from marko-js/zed languages/marko/outline.scm
; (snapshot dd854edec1fab86d23eb24af9691505dfe3856a6), with the reviewed
; mx/shorthand-anywhere change: an element is labeled with its tag name and
; its tag-adjacent #id/.class/:name shorthands (the `shorthand` field),
; never with attribute-position ones. scripts/vendor.sh copies this file to
; languages/mx/outline.scm.

; Outline entries, in Zed's outline.scm @item/@name convention (other
; tools ignore this file). Every element appears, labeled with its tag
; name and its tag-adjacent #id/.class/:name shorthands. Statement tags
; (import/export/static/…) are statements rather than document structure,
; so they are excluded.

((element
   (tag_name) @name
   shorthand: [(shorthand_id) (shorthand_class) (shorthand_name)]* @name) @item
 (#not-any-of? @name "import" "export" "class" "static" "server" "client"))

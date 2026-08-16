#!/bin/sh
# The assembly oracle: show what clang emits for a C snippet, denoised.
#
#   tools/oracle.sh 'int main(void){ return 1 ? 2 : 3; }'     # inline snippet
#   tools/oracle.sh path/to/file.c                            # or a file
#   tools/oracle.sh -O1 'int f(int a){ return a + 1; }'       # pick the level
#   tools/oracle.sh --shape foo.c                             # opcodes only
#   tools/oracle.sh --diff foo.c                              # full text diff
#
# WHICH MODE:
#
#   (default)  Read clang's output and compare it against what you PREDICTED.
#              This is where nearly all the value is — predict first, then run.
#   --shape    Opcode sequences side by side, operands and label names dropped.
#              Compares control-flow skeleton and instruction selection while
#              ignoring the choices the ABI leaves free. The one to reach for
#              when asking "is my loop the same shape as clang's?".
#   --diff     Full text diff. Mostly noise until you've deliberately adopted
#              clang's shape for something, because fp-vs-sp addressing,
#              scratch-register choice, leaf frames and label naming all differ
#              legitimately. Useful as a regression check, not for learning.
#
# WHICH -O TO ASK FOR (this is the part that matters):
#
#   -O0  the default here. Naive, literal, one-thing-at-a-time code that keeps
#        every local in a stack slot. Use it for anything STRUCTURAL — frame
#        layout, where locals live, the shape of a loop or an if. At -O1 there
#        is often no frame at all and nothing to compare against.
#
#   -O1  use for INSTRUCTION SELECTION — "what's the good way to say this?"
#        (cbz vs cmp+b.eq, cset, csel, madd). But beware: -O1 also rotates
#        loops, folds constants, and deletes code whose result is unused, so
#        the STRUCTURE it shows you is not the structure you should write.
#
# Rule of thumb: -O0 answers "what goes where", -O1 answers "which instruction".
#
# Apple's arm64 ABI requires unwind tables, so .cfi_* directives can't be
# switched off with a flag — they're filtered out below instead.

set -eu

opt=-O0
mode=show

while [ $# -gt 0 ]; do
  case $1 in
    -O0 | -O1 | -O2 | -O3 | -Os | -Oz) opt=$1; shift ;;
    --diff) mode=diff; shift ;;
    --shape) mode=shape; shift ;;
    *) break ;;
  esac
done

if [ $# -eq 0 ]; then
  echo "usage: tools/oracle.sh [-O0|-O1] [--diff|--shape] <file.c | 'C source'>" >&2
  exit 2
fi

# A file if it exists on disk; otherwise treat the argument as source text.
if [ -f "$1" ]; then
  src=$1
  cleanup=""
else
  src=$(mktemp -t oracle).c
  printf '%s\n' "$1" > "$src"
  cleanup=$src
fi

# Strip the directives that carry no information for us: object-file metadata
# (.build_version/.section/.subsections/.file), symbol bookkeeping we already
# know we emit (.globl/.p2align), unwind tables (.cfi_*), and clang's `;`
# comments including the `; %bb.N` basic-block markers.
denoise() {
  grep -vE '^[[:space:]]*\.(build_version|section|subsections_via_symbols|p2align|globl|file|cfi_[a-z_]+)' |
    sed -E 's/[[:space:]]*;.*$//' |
    grep -vE '^[[:space:]]*$'
}

# Opcodes only, labels normalised. Throws away exactly the things the ABI
# leaves free — register names, stack offsets, label numbering, `movz` vs
# `mov` — and keeps the two things worth comparing against clang: the
# CONTROL-FLOW SHAPE (where labels and branches fall) and INSTRUCTION
# SELECTION (cbz vs cmp+beq). Use this rather than --diff when the question is
# "does my loop have the same skeleton", not "is my output identical".
shape() {
  denoise |
    sed -E 's/^[[:space:]]+//' |
    awk '{ if ($0 ~ /:$/) print "<label>"; else print $1 }'
}

# Assemble ours to a temp path so a bare filename argument isn't littered on.
acorncc_asm() {
  cp "$src" "${TMPDIR:-/tmp}/oracle.mine.c"
  ./acorncc -S "${TMPDIR:-/tmp}/oracle.mine.c"
  cat "${TMPDIR:-/tmp}/oracle.mine.s"
  rm -f "${TMPDIR:-/tmp}/oracle.mine.c" "${TMPDIR:-/tmp}/oracle.mine.s"
}

if [ "$mode" = diff ]; then
  clang -S "$opt" "$src" -o - 2>/dev/null | denoise > "${TMPDIR:-/tmp}/oracle.clang.s"
  acorncc_asm | denoise > "${TMPDIR:-/tmp}/oracle.acorncc.s"
  echo "--- clang $opt          +++ acorncc"
  diff -u "${TMPDIR:-/tmp}/oracle.clang.s" "${TMPDIR:-/tmp}/oracle.acorncc.s" || true
elif [ "$mode" = shape ]; then
  clang -S "$opt" "$src" -o - 2>/dev/null | shape > "${TMPDIR:-/tmp}/oracle.clang.sh.txt"
  acorncc_asm | shape > "${TMPDIR:-/tmp}/oracle.mine.sh.txt"
  printf '%-24s %s\n' "clang $opt" "acorncc"
  printf '%-24s %s\n' "------------" "-------"
  diff -y -W 48 "${TMPDIR:-/tmp}/oracle.clang.sh.txt" "${TMPDIR:-/tmp}/oracle.mine.sh.txt" || true
else
  clang -S "$opt" "$src" -o - 2>/dev/null | denoise
fi

[ -n "$cleanup" ] && rm -f "$cleanup"
exit 0

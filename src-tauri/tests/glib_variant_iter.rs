#![cfg(target_os = "linux")]

use glib::prelude::*;

// Exercise the safe public API against the same glib package resolved by GTK.
// Cargo.toml enables optimization for glib so the original UB is not hidden by
// an unoptimized build. No display server or user project is required.
const STRINGS: [&str; 5] = ["first", "", "角色", "音频 🎵", "last"];

#[test]
fn forward_string_iteration_preserves_empty_and_unicode_values() {
    let variant = STRINGS.to_variant();
    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.len(), STRINGS.len());
    for (index, expected) in STRINGS.iter().enumerate() {
        assert_eq!(iter.next(), Some(*expected));
        assert_eq!(iter.len(), STRINGS.len() - index - 1);
    }
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
}

#[test]
fn backward_string_iteration_preserves_empty_and_unicode_values() {
    let variant = STRINGS.to_variant();
    let actual: Vec<_> = variant.array_iter_str().unwrap().rev().collect();
    assert_eq!(actual, STRINGS.into_iter().rev().collect::<Vec<_>>());
}

#[test]
fn indexed_and_mixed_direction_iteration_borrow_the_correct_strings() {
    let variant = STRINGS.to_variant();
    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.nth(1), Some(""));
    assert_eq!(iter.nth_back(1), Some("音频 🎵"));
    assert_eq!(iter.next_back(), Some("角色"));
    assert_eq!(iter.next(), None);
    assert_eq!(iter.nth_back(0), None);
}

#[test]
fn last_string_is_accessible_after_consuming_both_ends() {
    let variant = STRINGS.to_variant();
    assert_eq!(variant.array_iter_str().unwrap().last(), Some("last"));
    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.next_back(), Some("last"));
    assert_eq!(iter.last(), Some("音频 🎵"));
}

#[test]
fn empty_and_out_of_range_iterators_remain_exhausted() {
    let empty: [&str; 0] = [];
    let variant = empty.to_variant();
    assert_eq!(variant.array_iter_str().unwrap().next(), None);
    assert_eq!(variant.array_iter_str().unwrap().next_back(), None);
    assert_eq!(variant.array_iter_str().unwrap().last(), None);

    let variant = STRINGS.to_variant();
    let mut forward = variant.array_iter_str().unwrap();
    assert_eq!(forward.nth(usize::MAX), None);
    assert_eq!(forward.next_back(), None);
    let mut backward = variant.array_iter_str().unwrap();
    assert_eq!(backward.nth_back(usize::MAX), None);
    assert_eq!(backward.next(), None);
}

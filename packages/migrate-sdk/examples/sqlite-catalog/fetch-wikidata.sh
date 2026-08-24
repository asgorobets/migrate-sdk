#!/usr/bin/env bash

set -euo pipefail

fixture_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
query_file="${fixture_directory}/wikidata-books.rq"
output_file="${fixture_directory}/wikidata-books.csv"
temporary_file="${output_file}.tmp"

cleanup() {
  rm -f "${temporary_file}"
}

trap cleanup EXIT

curl \
  --fail-with-body \
  --location \
  --retry 3 \
  --retry-delay 2 \
  --max-time 60 \
  --header "Accept: text/csv" \
  --header "Content-Type: application/sparql-query" \
  --user-agent "migrate-sdk-sqlite-catalog/0.1 (https://github.com/asgorobets/migrate-sdk)" \
  --data-binary "@${query_file}" \
  --output "${temporary_file}" \
  "https://query.wikidata.org/sparql"

if ! head -n 1 "${temporary_file}" | grep -q '^work,workLabel,author,authorLabel,publisher,publisherLabel,publicationDate,isbn'; then
  echo "Wikidata returned an unexpected response" >&2
  head -n 3 "${temporary_file}" >&2
  exit 1
fi

mv "${temporary_file}" "${output_file}"
echo "Downloaded $(($(wc -l < "${output_file}") - 1)) Wikidata book records to ${output_file}"

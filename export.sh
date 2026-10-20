#!/bin/sh
# Ein Level als Website, die man irgendwo hinlegen kann (ein Webserver, der
# nur Dateien ausliefert, genügt; für VR über HTTPS):
#
#   ./export.sh nachtschicht ../nachtschicht-site
#   ./export.sh . ../mein-level              # dein Level: level.ini und rooms/ hier
#
# Kopiert die Engine, three.js, den Ordner des Levels (mit seinem
# gespeicherten Licht, level.light, »Save light«, und eigenen Modellen) und
# aus models/ nur die Modelle, die seine Räume nennen.
# Die Seite öffnet dieses Level ohne ?level=.
set -e
level=${1%/}
out=$2
if [ -z "$level" ] || [ -z "$out" ]; then
    echo "usage: ./export.sh LEVEL-FOLDER OUTPUT-FOLDER"
    exit 1
fi
cd "$(dirname "$0")"
[ -f "$level/level.ini" ] || { echo "$level/level.ini does not exist"; exit 1; }
[ -f "$level/level.light" ] || echo "note: $level/level.light is missing: every browser will bake the light itself"
rm -rf "$out"
mkdir -p "$out"
cp -R engine vendor "$out/"
if [ "$level" = "." ]; then
    # das Level der Vorlage selbst: level.ini, rooms/ und sein Licht
    cp level.ini "$out/"
    cp -R rooms "$out/"
    [ -f level.light ] && cp level.light "$out/"
else
    # der Ordner des Levels ganz (mit eigenen Modellen, etwa nachtschicht/models/), ohne .git
    mkdir -p "$out/$level"
    (cd "$level" && tar cf - --exclude=.git .) | (cd "$out/$level" && tar xf -)
fi
# die Modelle aus models/ der Vorlage, die seine Räume nennen (model = ...): ihr Ordner ganz
grep -hE '^[[:space:]]*model[[:space:]]*=' "$level"/rooms/*.room | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]#].*$//' | sort -u | while read -r file; do
    case "$file" in
        "$level"/*) ;;
        models/*/*) folder=$(echo "$file" | cut -d/ -f1-2); mkdir -p "$out/models"; cp -R "$folder" "$out/models/" ;;
        *) mkdir -p "$out/$(dirname "$file")"; cp "$file" "$out/$file" ;;
    esac
done
if [ "$level" = "." ]; then cp index.html "$out/"
else sed "s|<html lang=\"en\">|<html lang=\"en\" data-level=\"$level\">|" index.html > "$out/index.html"
fi
echo "$out: $(du -sh "$out" | cut -f1)"

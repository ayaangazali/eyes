"""Generate the 'Eyes: on shift' loop shortcut plist (unsigned).

Usage: python3 worker-location-on-shift-gen.py OUT URL COUNT WAIT_S [TOKEN]
  prod: OUT https://api.eyes.pictures/w/location 240 60
  test: OUT http://127.0.0.1:8789/w/location 3 60 x   (local testing only)

No menu and no variables. COUNT is a fixed Repeat count. The worker stops the run
from the Shortcuts banner when the shift ends. TOKEN empty -> import question asks for it.
Sign with: shortcuts sign --mode anyone -i OUT.shortcut -o SIGNED.shortcut
"""
import plistlib
import sys
import uuid

out, url = sys.argv[1], sys.argv[2]
count, wait_s = int(sys.argv[3]), int(sys.argv[4])
token = sys.argv[5] if len(sys.argv) > 5 else ""

# No 401 detection: a bad code is just rejected by the server each minute.

G_R = str(uuid.uuid4()).upper()  # repeat grouping
U_TOK = str(uuid.uuid4()).upper()
U_LOC = str(uuid.uuid4()).upper()
U_DATE = str(uuid.uuid4()).upper()
U_ISO = str(uuid.uuid4()).upper()


def out_of(uid, name, prop=None):
    a = {"Type": "ActionOutput", "OutputUUID": uid, "OutputName": name}
    if prop:
        a["Aggrandizements"] = [{"Type": "WFPropertyVariableAggrandizement", "PropertyName": prop}]
    return a


def tok(prefix, att, suffix=""):
    s = prefix + "\ufffc" + suffix
    return {"Value": {"string": s, "attachmentsByRange": {f"{{{len(prefix)}, 1}}": att}},
            "WFSerializationType": "WFTextTokenString"}


def plain(s):
    return {"Value": {"string": s}, "WFSerializationType": "WFTextTokenString"}


def item(key, value, kind=0):  # kind 0 text, 3 number
    return {"WFItemType": kind, "WFKey": plain(key), "WFValue": value}


def act(ident, **params):
    return {"WFWorkflowActionIdentifier": ident, "WFWorkflowActionParameters": params}


actions = [
    # 0. Token text. Import question fills it in prod.
    act("is.workflow.actions.gettext", UUID=U_TOK, WFTextActionText=plain(token)),
    # 1. Fixed repeat
    act("is.workflow.actions.repeat.count", GroupingIdentifier=G_R, WFControlFlowMode=0, WFRepeatCount=count),
    # 2. Location, then ISO 8601 timestamp
    act("is.workflow.actions.getcurrentlocation", UUID=U_LOC),
    act("is.workflow.actions.date", UUID=U_DATE, WFDateActionMode="Current Date"),
    act("is.workflow.actions.format.date", UUID=U_ISO, WFDateFormatStyle="ISO 8601",
        WFISO8601IncludeTime=True, WFDate=tok("", out_of(U_DATE, "Date"))),
    # 3. POST (response ignored; no 401 detection)
    act("is.workflow.actions.downloadurl",
        WFURL=url, WFHTTPMethod="POST", WFHTTPBodyType="JSON", ShowHeaders=False,
        WFHTTPHeaders={"Value": {"WFDictionaryFieldValueItems": [
            item("Authorization", tok("Bearer ", out_of(U_TOK, "Text")))]},
            "WFSerializationType": "WFDictionaryFieldValue"},
        WFJSONValues={"Value": {"WFDictionaryFieldValueItems": [
            item("lat", tok("", out_of(U_LOC, "Current Location", "Latitude")), 3),
            item("lng", tok("", out_of(U_LOC, "Current Location", "Longitude")), 3),
            item("source", plain("shortcut")),
            item("captured_at", tok("", out_of(U_ISO, "Formatted Date"))),
        ]}, "WFSerializationType": "WFDictionaryFieldValue"}),
    # 4. Wait, then end of repeat
    act("is.workflow.actions.delay", WFDelayTime=wait_s),
    act("is.workflow.actions.repeat.count", GroupingIdentifier=G_R, WFControlFlowMode=2),
    # 5. Done
    act("is.workflow.actions.notification", WFNotificationActionTitle="Eyes",
        WFNotificationActionBody="Eyes shift ended"),
]

wf = {
    "WFWorkflowActions": actions,
    "WFWorkflowClientVersion": "2607.0.2",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4292093695, "WFWorkflowIconGlyphNumber": 59511},
    "WFWorkflowTypes": [],
    "WFWorkflowInputContentItemClasses": ["WFStringContentItem"],
    "WFWorkflowHasShortcutInputVariables": False,
    "WFWorkflowImportQuestions": [] if token else [{
        "ActionIndex": 0, "Category": "Parameter", "ParameterKey": "WFTextActionText",
        "Text": "Paste the Eyes code from your text message", "DefaultValue": ""}],
}
with open(out, "wb") as f:
    plistlib.dump(wf, f, fmt=plistlib.FMT_BINARY)
print("wrote", out, "actions:", len(actions), "url:", url, "repeat:", count, "wait_s:", wait_s)

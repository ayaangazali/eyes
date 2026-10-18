"""Generate the 'Eyes: I'm here' shortcut plist. Usage: python3 gen.py OUT URL [TOKEN]
TOKEN empty -> import question asks for it at install time."""
import plistlib, sys, uuid

out, url = sys.argv[1], sys.argv[2]
token = sys.argv[3] if len(sys.argv) > 3 else ""
U_TOK, U_LOC = str(uuid.uuid4()).upper(), str(uuid.uuid4()).upper()


def tok(prefix, att, suffix=""):
    s = prefix + "\ufffc" + suffix
    return {"Value": {"string": s, "attachmentsByRange": {f"{{{len(prefix)}, 1}}": att}},
            "WFSerializationType": "WFTextTokenString"}


def out_of(uid, name, prop=None):
    a = {"Type": "ActionOutput", "OutputUUID": uid, "OutputName": name}
    if prop:
        a["Aggrandizements"] = [{"Type": "WFPropertyVariableAggrandizement", "PropertyName": prop}]
    return a


def item(key, value, kind=0):  # kind 0 text, 3 number
    return {"WFItemType": kind, "WFKey": {"Value": {"string": key}, "WFSerializationType": "WFTextTokenString"},
            "WFValue": value}


def plain(s):
    return {"Value": {"string": s}, "WFSerializationType": "WFTextTokenString"}


actions = [
    {"WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
     "WFWorkflowActionParameters": {"UUID": U_TOK, "WFTextActionText": token}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.getcurrentlocation",
     "WFWorkflowActionParameters": {"UUID": U_LOC}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
     "WFWorkflowActionParameters": {
         "WFURL": url, "WFHTTPMethod": "POST", "WFHTTPBodyType": "JSON", "ShowHeaders": True,
         "WFHTTPHeaders": {"Value": {"WFDictionaryFieldValueItems": [
             item("Authorization", tok("Bearer ", out_of(U_TOK, "Text")))]},
             "WFSerializationType": "WFDictionaryFieldValue"},
         "WFJSONValues": {"Value": {"WFDictionaryFieldValueItems": [
             item("lat", tok("", out_of(U_LOC, "Current Location", "Latitude")), 3),
             item("lng", tok("", out_of(U_LOC, "Current Location", "Longitude")), 3),
             item("source", plain("shortcut")),
             # Message-trigger automations pass the received text; server matches the ping nonce.
             item("input", tok("", {"Type": "ExtensionInput"})),
         ]}, "WFSerializationType": "WFDictionaryFieldValue"}}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.notification",
     "WFWorkflowActionParameters": {"WFNotificationActionTitle": "Eyes",
                                    "WFNotificationActionBody": "Location sent"}},
]

wf = {
    "WFWorkflowActions": actions,
    "WFWorkflowClientVersion": "2607.0.2",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4292093695, "WFWorkflowIconGlyphNumber": 59511},
    "WFWorkflowTypes": [],
    "WFWorkflowInputContentItemClasses": ["WFStringContentItem"],
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowImportQuestions": [] if token else [{
        "ActionIndex": 0, "Category": "Parameter", "ParameterKey": "WFTextActionText",
        "Text": "Paste the Eyes code from your text message", "DefaultValue": ""}],
}
with open(out, "wb") as f:
    plistlib.dump(wf, f, fmt=plistlib.FMT_BINARY)
print("wrote", out)

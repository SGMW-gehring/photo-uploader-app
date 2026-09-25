package org.json;
public class JSONObject {
    public static String quote(String s){return "\"" + (s==null?"":s) + "\"";}
    public JSONObject(){}
    public JSONObject(String s) throws Exception {}
    public JSONObject put(String k,Object v) throws Exception {return this;}
    public Object get(String k) throws Exception {return null;}
    public String optString(String k){return "";}
    public String optString(String k,String d){return d;}
    public String toString(){return "{}";}
}

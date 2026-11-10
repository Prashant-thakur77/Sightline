import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(92);
Config.setPixelFormat("yuv420p");
Config.setColorSpace("bt709"); // one colourspace for every part, or joins reset the filters
Config.setChromiumOpenGlRenderer("swangle"); // the WebGL that works headless on this machine
Config.setConcurrency(null);

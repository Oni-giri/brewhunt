class Blink1 < Formula
  desc "Control blink(1) indicator light"
  homepage "https://blink1.thingm.com/"
  url "https://github.com/todbot/blink1-tool.git",
      tag:      "v2.5.0",
      revision: "600da2c6f14e22fecee0e3871463cdab99a68525"
  license any_of: ["CC-BY-SA-4.0", "MIT"]
  head "https://github.com/todbot/blink1-tool.git", branch: "main"

  on_linux do
    depends_on "pkgconf" => :build
    depends_on "systemd"
  end

  def install
    mkdir_p [bin, include, lib/"pkgconfig"]
    system "make"
    system "make", "install", "install-dev", "PREFIX=#{prefix}"
  end

  test do
    system bin/"blink1-tool", "--version"
  end
end
